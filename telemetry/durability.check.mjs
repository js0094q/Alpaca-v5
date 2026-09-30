import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvidenceWriter } from './evidence-writer.mjs';
import { createPostExitEvidence } from './post-exit.mjs';
import { createPostExitProcessor } from './post-exit-worker.mjs';
import { createTrace } from './trace.mjs';

// Offline telemetry durability check. All files are temporary; no bot or broker is used.
const root = await mkdtemp(join(tmpdir(), 'v5-telemetry-durability-'));
const waitFor = async (condition, label) => {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert(Date.now() < deadline, `${label}: bounded worker wait exceeded`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const readJsonl = async (directory, predicate = (name) => name.endsWith('.jsonl')) => {
  const names = (await readdir(directory)).filter(predicate).sort();
  const rows = [];
  for (const name of names) {
    const text = await readFile(join(directory, name), 'utf8');
    rows.push(...text.trim().split('\n').filter(Boolean).map(JSON.parse));
  }
  return { names, rows };
};

try {
  // A synchronous burst fills the ordinary queue before the worker can drain it.
  const traceDir = join(root, 'trace');
  const trace = createTrace({ directory: traceDir, capacity: 8, batchSize: 8, flushMs: 10, shutdownMs: 1_000 });
  for (let i = 0; i < 20; i++) trace.emit('ordinary_probe', { i });
  assert.equal(trace.emit('lot_decision', { action: 'HOLD' }), false, 'ordinary lot decision cannot consume the transition reserve');
  assert.equal(trace.emit('lot_decision', { action: 'LOSS_LATCH', id: 'reserved-transition' }), true, 'critical lot transition enters reserve at saturation');
  const firstRunId = trace.status().runId;
  trace.stop();
  await waitFor(() => trace.status().stopped || trace.status().failed, 'trace drain');
  assert.equal(trace.status().failed, false, 'writer completed without failure');
  const firstRun = await readJsonl(traceDir, (name) => name.startsWith('v5-trace-'));
  const records = firstRun.rows.filter((row) => row.runId === firstRunId && Number.isInteger(row.sequence));
  assert(records.some((row) => row.event === 'lot_decision' && row.fields.action === 'LOSS_LATCH' && row.fields.id === 'reserved-transition'));
  assert(!records.some((row) => row.event === 'lot_decision' && row.fields.action === 'HOLD'));
  const sequences = records.map((row) => row.sequence);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b), 'persisted event sequence remains ordered');
  assert.equal(trace.status().emitted - records.length, trace.status().dropped, 'sequence gaps match explicitly counted queue drops');
  assert(trace.status().dropped > 0, 'the saturation path exercised drops');

  // A second run in the same directory must leave the first run inspectable.
  const restart = createTrace({ directory: traceDir, capacity: 32, batchSize: 8, flushMs: 10, shutdownMs: 1_000 });
  const secondRunId = restart.status().runId;
  for (let i = 0; i < 6; i++) restart.emit('restart_probe', { i });
  restart.stop();
  await waitFor(() => restart.status().stopped || restart.status().failed, 'restart drain');
  assert.equal(restart.status().failed, false);
  const afterRestart = await readJsonl(traceDir, (name) => name.startsWith('v5-trace-'));
  assert(afterRestart.rows.some((row) => row.runId === firstRunId && row.event === 'lot_decision' && row.fields.action === 'LOSS_LATCH'), 'prior run lifecycle evidence survives restart');
  assert(afterRestart.rows.some((row) => row.runId === secondRunId && row.event === 'restart_probe'));
  assert(afterRestart.names.length > 1, 'rotation created multiple retained segments');

  // A single run may exhaust its configured segment cap, but the writer must
  // report that condition without pruning its own earlier segment.
  const retentionDir = join(root, 'retention-cap');
  const boundedRetention = createTrace({ directory: retentionDir, capacity: 32, batchSize: 16,
    flushMs: 10, shutdownMs: 1_000, maxBytes: 2_048, maxSegments: 2 });
  for (let i = 0; i < 20; i++) boundedRetention.emit('retention_probe', { i, payload: 'r'.repeat(600) });
  boundedRetention.stop();
  await waitFor(() => boundedRetention.status().failed || boundedRetention.status().stopped, 'retention cap');
  assert.equal(boundedRetention.status().failed, true, 'same-run retention exhaustion is explicit');
  assert.equal(boundedRetention.status().failure, 'RETENTION_LIMIT');
  const capped = await readJsonl(retentionDir, (name) => name.startsWith('v5-trace-'));
  assert(capped.names.length <= 2, 'same-run retention cap remains bounded');
  assert(capped.rows.some((row) => row.runId === boundedRetention.status().runId && row.event === 'retention_probe'), 'retention failure preserves inspectable current-run evidence');

  // Persist two independent post-exit lots through their own complete boundaries.
  const exitDir = join(root, 'post-exit');
  const runId = 'durability-run';
  const output = await createEvidenceWriter({ directory: exitDir, runId });
  const processor = createPostExitProcessor({ write: (row) => output.write(row), runId, nowMono: () => 30_000 });
  const base = Date.now();
  const accountHash = 'a'.repeat(64);
  await processor.accept({ event: 'post_exit_context', wallTimeMs: base, monoMs: 0, fields: { mode: 'paper', accountHash, sessionDate: '2026-09-28' } });
  const lots = [
    { id: 'lot-one', symbol: 'SPY261002C00650000', entry: 'entry-one', exit: 'exit-one' },
    { id: 'lot-two', symbol: 'SPY261002C00655000', entry: 'entry-two', exit: 'exit-two' },
  ];
  for (const lot of lots) {
    await processor.accept({ event: 'entry_fill_link', wallTimeMs: base, monoMs: 0, fields: {
      tradeId: lot.id, entrySetId: `set-${lot.id}`, tradeSetId: `set-${lot.id}`, signalId: `signal-${lot.id}`,
      actionSource: 'V5_AUTO', orderId: `buy-${lot.id}`, clientOrderId: `set-${lot.id}`,
      executionId: lot.entry, entryPrice: 1, quantity: 1, symbol: lot.symbol, brokerTimestamp: base - 60_000,
    } });
    await processor.accept({ event: 'position_exit', wallTimeMs: base, monoMs: 0, fields: {
      tradeId: lot.id, executionId: lot.exit, symbol: lot.symbol, quantity: 1, price: 1.1, brokerTimestamp: base,
    } });
  }
  for (const lot of lots) await processor.accept({ event: 'post_exit_quote_input', wallTimeMs: base + 30_000, monoMs: 30_000, fields: {
    symbol: lot.symbol, bid: 1.12, ask: 1.13, sourceTimestamp: new Date(base + 30_000).toISOString(),
    sourceTimestampMs: base + 30_000, receivedAtMs: base + 30_000, receivedMonoMs: 30_000,
  } });
  await processor.stop();
  await output.close();
  const persisted = await readJsonl(exitDir, (name) => name.startsWith('post-exit-'));
  assert.equal(persisted.names.length, lots.length, 'each lot has an independently inspectable evidence file');
  for (const lot of lots) {
    const rows = persisted.rows.filter((row) => row.fields.tradeId === lot.id);
    assert(rows.some((row) => row.event === 'POST_EXIT_START' && row.fields.exitExecutionId === lot.exit));
    assert(rows.some((row) => row.event === 'POST_EXIT_QUOTE' && row.fields.boundarySample === true));
    assert(rows.some((row) => row.event === 'POST_EXIT_END' && row.fields.status === 'complete'));
    assert(rows.every((row) => row.fields.mode === 'paper' && row.fields.accountHash === accountHash));
  }
  // Opening a fresh writer models process restart and confirms retained files remain readable.
  const reopened = await createEvidenceWriter({ directory: exitDir, runId: 'after-restart' });
  await reopened.close();
  const afterExitRestart = await readJsonl(exitDir, (name) => name.startsWith('post-exit-'));
  assert.equal(afterExitRestart.rows.filter((row) => row.event === 'POST_EXIT_END' && row.fields.status === 'complete').length, 2);

  // Exercise the public adapter's prequeue filtering and confirmed-exit tracking.
  const adapterDir = join(root, 'post-exit-adapter');
  const adapter = createPostExitEvidence({ directory: adapterDir });
  const beforeFilteredQuote = adapter.status().emitted;
  assert.equal(adapter.quote({ symbol: 'UNTRACKED', bid: 1, ask: 1.01 }), false, 'untracked symbol quote is rejected before queueing');
  assert.equal(adapter.status().emitted, beforeFilteredQuote, 'filtered quote consumes no trace queue slot');
  adapter.emit('post_exit_context', { mode: 'paper', accountHash, sessionDate: '2026-09-28' });
  const adapterLots = [];
  for (const lot of lots) {
    adapter.emit('entry_fill_link', { tradeId: lot.id, entrySetId: `set-${lot.id}`, tradeSetId: `set-${lot.id}`,
      signalId: `signal-${lot.id}`, actionSource: 'V5_AUTO', orderId: `buy-${lot.id}`, clientOrderId: `set-${lot.id}`,
      executionId: lot.entry, entryPrice: 1, quantity: 1, symbol: lot.symbol, brokerTimestamp: new Date(base - 60_000).toISOString() });
    adapter.emit('position_exit', { tradeId: lot.id, executionId: lot.exit, symbol: lot.symbol, quantity: 1,
      price: 1.1, brokerTimestamp: new Date(base).toISOString() });
    adapterLots.push({ ...lot, startMono: performance.now() });
  }
  for (const lot of adapterLots) {
    assert.equal(adapter.quote({ symbol: lot.symbol, bid: 1.1, ask: 1.11, timestamp: new Date(base).toISOString() }, base, lot.startMono + 1), true);
  }
  for (const lot of adapterLots) {
    assert.equal(adapter.quote({ symbol: lot.symbol, bid: 1.12, ask: 1.13, timestamp: new Date(base + 30_000).toISOString() }, base + 30_000, lot.startMono + 30_000), true);
  }
  adapter.stop();
  await waitFor(() => adapter.status().stopped || adapter.status().failed, 'post-exit adapter drain');
  assert.equal(adapter.status().failed, false, 'adapter evidence worker completed');
  const adapterRows = await readJsonl(adapterDir, (name) => name.startsWith('post-exit-'));
  for (const lot of lots) {
    const rows = adapterRows.rows.filter((row) => row.fields.tradeId === lot.id);
    assert(rows.some((row) => row.event === 'POST_EXIT_QUOTE' && row.fields.boundarySample === true), `adapter retained ${lot.id} boundary quote`);
    assert(rows.some((row) => row.event === 'POST_EXIT_END' && row.fields.status === 'complete'), `adapter completed ${lot.id} window`);
  }

  // Bounded synchronous callback latency comparison: disabled baseline vs enabled emitter.
  const disabled = createTrace({ enabled: false });
  const bench = createTrace({ directory: join(root, 'latency'), capacity: 4096, batchSize: 128, flushMs: 10, shutdownMs: 1_000 });
  await waitFor(() => bench.status().ready, 'latency worker ready');
  const fields = { tradeId: 'benchmark-lot', symbol: lots[0].symbol, bid: 1.12, ask: 1.13 };
  const measure = (emit, n = 500) => {
    const samples = [];
    for (let i = 0; i < n; i++) {
      const start = performance.now();
      emit('position_quote_accepted', fields);
      samples.push((performance.now() - start) * 1_000);
    }
    samples.sort((a, b) => a - b);
    return { unit: 'microseconds', n, p50: samples[Math.floor(n * 0.50)], p95: samples[Math.floor(n * 0.95)], mean: samples.reduce((sum, value) => sum + value, 0) / n };
  };
  const latency = { baseline: measure(disabled.emit), enabled: measure(bench.emit) };
  const burstCount = 2_790;
  const burstStart = performance.now();
  // 100 short chunks produce a bounded ~100ms burst near the observed rate.
  for (let baseIndex = 0; baseIndex < burstCount; baseIndex += 28) {
    for (let i = baseIndex; i < Math.min(burstCount, baseIndex + 28); i++) bench.emit('bounded_burst_probe', { i });
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const burstDurationMs = performance.now() - burstStart;
  await waitFor(() => bench.status().queued === 0 && bench.status().inFlight === 0, 'latency and burst queue drain');
  assert.equal(bench.status().dropped, 0, 'latency and bounded burst samples were accepted');
  assert.equal(bench.status().written, bench.status().emitted, 'all accepted latency and burst events were acknowledged');
  const burst = { emitted: burstCount, written: bench.status().written - 500, dropped: bench.status().dropped,
    durationMs: burstDurationMs, eventsPerSecond: burstCount / (burstDurationMs / 1_000) };
  bench.stop();
  await waitFor(() => bench.status().stopped || bench.status().failed, 'latency worker stop');
  assert.equal(bench.status().failed, false);

  // One additional bounded instantaneous burst measures an achieved rate above 28k/s.
  const peak = createTrace({ directory: join(root, 'peak-burst'), capacity: 8192, batchSize: 512, flushMs: 10, shutdownMs: 1_000 });
  const peakStart = performance.now();
  const peakCount = 3_000;
  for (let i = 0; i < peakCount; i++) peak.emit('peak_burst_probe', { i });
  const peakEmitMs = performance.now() - peakStart;
  const peakDrainStart = performance.now();
  peak.stop();
  await waitFor(() => peak.status().stopped || peak.status().failed, 'peak burst drain');
  const peakDrainMs = performance.now() - peakDrainStart;
  assert.equal(peak.status().failed, false);
  assert.equal(peak.status().emitted, peakCount);
  assert.equal(peak.status().written, peakCount);
  assert.equal(peak.status().dropped, 0);
  const peakBurst = { emitted: peak.status().emitted, written: peak.status().written, dropped: peak.status().dropped,
    emitDurationMs: peakEmitMs, achievedEventsPerSecond: peakCount / (peakEmitMs / 1_000), workerDrainMs: peakDrainMs };
  assert(peakBurst.achievedEventsPerSecond >= 28_000, `instantaneous bounded burst reached ${peakBurst.achievedEventsPerSecond.toFixed(0)} events/s, below 28,000`);

  console.log(JSON.stringify({ ok: true, checks: [
    'critical lot transition persists while ordinary HOLD decisions are rejected at queue saturation',
    'persisted event sequences are ordered and sequence gaps equal counted drops',
    'prior run remains inspectable after a subsequent run starts in the same directory',
    'same-run retention cap fails explicitly without pruning its own retained evidence',
    'each of two lots persists its own complete post-exit boundary window',
    'post-exit evidence remains inspectable after writer restart',
    'untracked public-adapter quotes are filtered before queueing and confirmed lot windows retain boundary samples',
  ], trace: { dropped: trace.status().dropped, retainedSegmentsAfterRestart: afterRestart.names.length }, latency, burst, peakBurst }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
