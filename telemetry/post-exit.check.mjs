import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvidenceWriter } from './evidence-writer.mjs';
import { createPostExitEvidence } from './post-exit.mjs';
import { createPostExitProcessor } from './post-exit-worker.mjs';
import { createTrace } from './trace.mjs';
import { createPositions } from '../positions.mjs';

// Offline persistence checks only. All evidence is written under the system temp directory.
const root = await mkdtemp(join(tmpdir(), 'v5-post-exit-check-'));
const identity = {
  mode: 'paper', accountHash: 'a'.repeat(64), tradeId: 'trade-a', entrySetId: 'entry-set-a',
  entryExecutionId: 'buy-exec-a', exitExecutionId: 'sell-exec-a', symbol: 'SPY260924C00770000',
  entryTimestampMs: 1_000, exitTimestampMs: 11_000,
};
const row = (windowId, event, wallTimeMs, fields = {}) => ({
  schema: 1, runId: 'run-a', windowId, event, wallTimeMs,
  fields: { ...identity, ...fields },
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (condition) => {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert(Date.now() < deadline, 'bounded worker wait exceeded');
    await sleep(10);
  }
};

async function processorRows(input, monoSequence = [0, 1, 2, 3]) {
  const output = [];
  let index = 0;
  const processor = createPostExitProcessor({ write: async (value) => output.push(value), runId: 'processor-run', nowMono: () => monoSequence[Math.min(index++, monoSequence.length - 1)] });
  for (const value of input) await processor.accept(value);
  await processor.stop();
  return output;
}

async function replay(evidence) {
  const orders = [], events = [];
  let wall = Date.now();
  const symbol = 'SPY260924C00770000';
  const positions = createPositions({
    broker: { async submitOrder(order) { orders.push(['submit', order]); return { id: 'sell-1', status: 'accepted' }; }, async replaceOrder(id, order) { orders.push(['replace', id, order]); return { id, status: 'accepted' }; }, async cancelOrder(id) { orders.push(['cancel', id]); } },
    now: () => wall,
    telemetry(event, fields) { events.push([event, fields]); try { evidence?.emit(event, fields); } catch {} },
  });
  const quote = (bid, offset) => {
    wall += offset;
    const value = { symbol, bid, ask: bid + 0.01, timestamp: new Date(wall).toISOString() };
    positions.onQuote(value); // Normal order and strategy path runs before observational capture.
    try { evidence?.quote(value); } catch {}
  };
  const entryTimestamp = wall;
  const fill = { executionId: 'buy-exec-1', tradeId: 'trade-1', symbol, entryPrice: 1, timestamp: entryTimestamp };
  positions.onFill(fill);
  evidence?.emit('entry_fill_link', { tradeId: fill.tradeId, signalId: 'signal-fixture', tradeSetId: 'entry-set-1', entrySetId: 'entry-set-1', actionSource: 'V5_AUTO', clientOrderId: 'entry-set-1', orderId: 'buy-order-1', entryPrice: 1, executionId: fill.executionId, symbol, brokerTimestamp: entryTimestamp });
  quote(1, 10_000);
  quote(1.10, 1); // Arms the trail; floor 1.06.
  quote(1.04, 1); // Intent and accepted SELL request; no exit evidence yet.
  await sleep(0);
  assert.equal(orders.length, 1);
  assert.equal(events.some(([name]) => name === 'position_exit'), false, 'SELL intent is not an actual exit');
  const exitTimestamp = wall + 1;
  positions.onOrderUpdate({ event: 'fill', orderId: 'sell-1', executionId: 'sell-exec-1', fillQty: 1, fillPrice: 1.04, timestamp: exitTimestamp });
  const afterExit = positions.getTrades().map(({ tradeId, remainingQty, sellLatched }) => ({ tradeId, remainingQty, sellLatched }));
  quote(1.03, 1);
  const comparableOrders = orders.map(([operation, ...args]) => [operation, ...args.map((value) => value && typeof value === 'object' && 'clientOrderId' in value ? { ...value, clientOrderId: 'v5-sell-UUID' } : value)]);
  return { orders: comparableOrders, events, afterExit, tradeId: fill.tradeId };
}

try {
  const paperDirectory = join(root, 'paper');
  const liveDirectory = join(root, 'live');
  await mkdir(paperDirectory);
  const runner = await readFile(new URL('../paper.mjs', import.meta.url), 'utf8');
  assert.match(runner, /runtime = createRuntime\(\{ broker, telemetry: emit,/);
  assert.match(runner, /try \{ telemetry\?\.\(event, fields\); \} catch \{\}\s*try \{ postExitEvidence\?\.emit\(event, fields\); \} catch \{\}/);
  assert.match(runner, /dispatch\(runtime, name, value\);\s*if \(name === 'opra'\) \{ try \{ postExitEvidence\?\.quote\(value, receivedAtMs, receivedMonoMs\);/);

  const disabledReplay = await replay({ emit() {}, quote() {} });
  const faultPath = join(root, 'not-a-directory');
  await writeFile(faultPath, 'block worker directory');
  const failedEvidence = createPostExitEvidence({ directory: faultPath });
  const failedReplay = await replay(failedEvidence);
  await waitFor(() => failedEvidence.status().stopped || failedEvidence.status().failed);
  failedEvidence.stop();
  assert.deepEqual(failedReplay.orders, disabledReplay.orders, 'writer initialization failure does not change strategy orders');
  assert.deepEqual(failedReplay.afterExit, disabledReplay.afterExit, 'writer initialization failure does not change position state');

  const workerDirectory = join(root, 'worker-output');
  await mkdir(workerDirectory);
  const evidence = createPostExitEvidence({ directory: workerDirectory });
  evidence.emit('post_exit_context', { mode: 'paper', accountHash: 'b'.repeat(64), sessionDate: '2026-09-27' });
  const enabledReplay = await replay(evidence);
  assert.deepEqual(enabledReplay.orders, disabledReplay.orders, 'worker-backed evidence does not change strategy orders');
  assert.deepEqual(enabledReplay.afterExit, disabledReplay.afterExit, 'worker-backed evidence does not change position state');
  evidence.stop();
  await waitFor(() => evidence.status().stopped);
  const evidenceFiles = (await readdir(workerDirectory)).filter((name) => name.startsWith('post-exit-'));
  assert.equal(evidenceFiles.length, 1, 'worker persists one actual exit window');
  const workerRows = (await readFile(join(workerDirectory, evidenceFiles[0]), 'utf8')).trim().split('\n').map(JSON.parse);
  assert(workerRows.some((entry) => entry.event === 'POST_EXIT_START' && entry.fields.exitExecutionId === 'sell-exec-1'));
  assert(workerRows.some((entry) => entry.event === 'POST_EXIT_QUOTE' && entry.fields.tradeId === enabledReplay.tradeId));
  assert(workerRows.some((entry) => entry.event === 'POST_EXIT_END' && entry.fields.status === 'partial'));
  assert(!workerRows.some((entry) => entry.event === 'POST_EXIT_GAP' && entry.fields.reason === 'trace_queue_loss'), 'a small unsaturated replay must not invent a queue-loss gap');
  assert(workerRows.every((entry) => entry.fields.mode === 'paper' && entry.fields.accountHash === 'b'.repeat(64)));

  const genericDirectory = join(root, 'generic-trace');
  const genericTrace = createTrace({ directory: genericDirectory, maxBytes: 4096, maxSegments: 2, flushMs: 10, shutdownMs: 1_000 });
  for (let index = 0; index < 30; index++) genericTrace.emit('rotation_probe', { index, payload: 'x'.repeat(256) });
  genericTrace.stop();
  await waitFor(() => genericTrace.status().stopped);
  const rotated = (await readdir(genericDirectory)).filter((name) => name.endsWith('.jsonl'));
  assert.equal(rotated.length, 2, 'generic trace obeys bounded segment rotation');
  const rotatedRows = (await Promise.all(rotated.map(async (name) => (await readFile(join(genericDirectory, name), 'utf8')).trim().split('\n').map(JSON.parse)))).flat();
  assert(rotatedRows.some((entry) => entry.event === 'rotation_probe'));
  assert(workerRows.some((entry) => entry.event === 'POST_EXIT_START' && entry.fields.exitExecutionId === 'sell-exec-1'), 'generic rotation cannot remove joined exit evidence');

  const stamp = Date.now();
  const context = { event: 'post_exit_context', wallTimeMs: stamp, monoMs: 0, fields: { mode: 'paper', accountHash: 'c'.repeat(64), sessionDate: '2026-09-27' } };
  const entry = { event: 'entry_fill_link', wallTimeMs: stamp, monoMs: 0, fields: { tradeId: 'processor-trade', signalId: 'signal-1', tradeSetId: 'set-1', entrySetId: 'set-1', actionSource: 'V5_AUTO', clientOrderId: 'set-1', orderId: 'buy-1', entryPrice: 1, executionId: 'entry-exec', symbol: 'SPY260924C00770000', brokerTimestamp: stamp - 20_000 } };
  const exit = { event: 'position_exit', wallTimeMs: stamp, monoMs: 0, fields: { tradeId: 'processor-trade', executionId: 'exit-exec-1', symbol: 'SPY260924C00770000', quantity: 1, price: 1.1, brokerTimestamp: stamp } };
  const duplicateRows = await processorRows([context, entry, exit, { ...exit, wallTimeMs: stamp + 1, fields: { ...exit.fields } }]);
  assert.equal(duplicateRows.filter((value) => value.event === 'POST_EXIT_START').length, 1, 'duplicate trade and exit execution notifications create one window');
  const partialRows = await processorRows([context, entry, exit, { ...exit, wallTimeMs: stamp + 1, fields: { ...exit.fields, executionId: 'exit-exec-2', quantity: 0.5 } }]);
  assert.equal(partialRows.filter((value) => value.event === 'POST_EXIT_START').length, 2, 'distinct partial exit executions retain separate windows');

  const droppedRows = [];
  const droppedProcessor = createPostExitProcessor({ write: async (value) => droppedRows.push(value), runId: 'processor-run' });
  await droppedProcessor.batch([context, entry, exit], { dropped: 1, truncated: 0 });
  await droppedProcessor.stop();
  assert(droppedRows.some((value) => value.event === 'POST_EXIT_GAP' && value.fields.reason === 'trace_queue_loss'), 'queue loss in the batch that opens a window is recorded on that window');

  const endpointRows = await processorRows([context, entry, exit, {
    event: 'post_exit_quote_input', wallTimeMs: stamp + 30_000, monoMs: 30_000,
    fields: { symbol: 'SPY260924C00770000', bid: 1, ask: 1.01, sourceTimestampMs: stamp + 30_000, receivedAtMs: stamp + 30_000, receivedMonoMs: 30_000 },
  }], [0, 30_000, 30_001]);
  assert.equal(endpointRows.filter((value) => value.event === 'POST_EXIT_QUOTE').length, 1, 'the boundary sample is retained to establish endpoint coverage');
  assert(endpointRows.some((value) => value.event === 'POST_EXIT_QUOTE' && value.fields.boundarySample === true));
  assert(endpointRows.some((value) => value.event === 'POST_EXIT_END' && value.fields.status === 'complete' && value.fields.boundarySample === true));
  const emptyRows = await processorRows([context, entry, exit,
    { event: 'post_exit_context', wallTimeMs: stamp + 31_001, monoMs: 31_001, fields: context.fields },
  ], [0, 31_001, 31_002]);
  assert(emptyRows.some((value) => value.event === 'POST_EXIT_END' && value.fields.status === 'partial' && value.fields.quoteCount === 0), 'empty windows cannot claim complete quote coverage');
  const denseQuotes = [context, entry, exit];
  for (let elapsed = 1_000; elapsed <= 29_000; elapsed += 1_000) denseQuotes.push({
    event: 'post_exit_quote_input', wallTimeMs: stamp + elapsed, monoMs: elapsed,
    fields: { symbol: 'SPY260924C00770000', bid: 1, ask: 1.01, sourceTimestampMs: stamp + elapsed, receivedAtMs: stamp + elapsed, receivedMonoMs: elapsed },
  });
  denseQuotes.push({ event: 'post_exit_quote_input', wallTimeMs: stamp + 30_500, monoMs: 30_500,
    fields: { symbol: 'SPY260924C00770000', bid: 1, ask: 1.01, sourceTimestampMs: stamp + 28_000, receivedAtMs: stamp + 30_500, receivedMonoMs: 30_500 } });
  const delayedBoundaryRows = await processorRows(denseQuotes);
  assert(delayedBoundaryRows.some((value) => value.event === 'POST_EXIT_QUOTE' && value.fields.receivedMonoMs === 30_500 && value.fields.stale && !value.fields.boundarySample));
  assert(delayedBoundaryRows.some((value) => value.event === 'POST_EXIT_END' && value.fields.status === 'partial'), 'stale delayed boundary source cannot claim complete horizon coverage');

  const fullDirectory = join(root, 'full-window');
  await mkdir(fullDirectory);
  const fullWriter = await createEvidenceWriter({ directory: fullDirectory, runId: 'full-run' });
  const fullProcessor = createPostExitProcessor({ write: (value) => fullWriter.write(value), runId: 'full-run' });
  const fullStart = Date.now();
  await fullProcessor.accept({ ...context, wallTimeMs: fullStart, monoMs: 0 });
  await fullProcessor.accept({ ...entry, wallTimeMs: fullStart, monoMs: 0, fields: { ...entry.fields, brokerTimestamp: fullStart - 20_000 } });
  await fullProcessor.accept({ ...exit, wallTimeMs: fullStart, monoMs: 0, fields: { ...exit.fields, brokerTimestamp: fullStart } });
  for (let elapsed = 1_000; elapsed <= 30_000; elapsed += 1_000) await fullProcessor.accept({
    event: 'post_exit_quote_input', wallTimeMs: fullStart + elapsed, monoMs: elapsed,
    fields: { symbol: 'SPY260924C00770000', bid: 1 + elapsed / 100_000, ask: 1.1 + elapsed / 100_000, sourceTimestampMs: fullStart + elapsed, receivedAtMs: fullStart + elapsed, receivedMonoMs: elapsed },
  });
  await fullProcessor.stop();
  await fullWriter.close();
  const fullFiles = (await readdir(fullDirectory)).filter((name) => name.endsWith('.jsonl'));
  assert.equal(fullFiles.length, 1);
  const fullWindowText = await readFile(join(fullDirectory, fullFiles[0]), 'utf8');
  const fullRows = fullWindowText.trim().split('\n').map(JSON.parse);
  assert.equal(fullRows.filter((value) => value.event === 'POST_EXIT_QUOTE').length, 30);
  assert(fullRows.some((value) => value.event === 'POST_EXIT_QUOTE' && value.fields.boundarySample));
  assert(fullRows.some((value) => value.event === 'POST_EXIT_END' && value.fields.status === 'complete'));
  const fullEnd = fullRows.find((value) => value.event === 'POST_EXIT_END');
  assert.equal(fullEnd.fields.tradeSetId, 'set-1');
  assert.equal(fullEnd.fields.signalId, 'signal-1');
  assert.equal(fullEnd.fields.actionSource, 'V5_AUTO');
  assert.equal(fullEnd.fields.orderId, 'buy-1');
  assert.equal(fullEnd.fields.clientOrderId, 'set-1');
  assert.equal(fullEnd.fields.entryClientOrderId, 'set-1');
  assert.equal(fullEnd.fields.postExitBidHigh, 1.3);
  assert.equal(fullEnd.fields.postExitBidLow, 1.01);
  assert.equal(Math.round(fullEnd.fields.favorableExcursionVsExitFill * 100), 20);
  assert.equal(Math.round(fullEnd.fields.adverseExcursionVsExitFill * 100), -9);

  const staleRows = await processorRows([context, entry, exit, {
    event: 'post_exit_quote_input', wallTimeMs: stamp + 1, monoMs: 1,
    fields: { symbol: 'SPY260924C00770000', bid: 1, ask: 1.01, sourceTimestampMs: stamp - 1, receivedAtMs: stamp + 1, receivedMonoMs: 1 },
  }]);
  assert(staleRows.some((value) => value.event === 'POST_EXIT_QUOTE' && value.fields.sourceBeforeExit === true));
  const changedAccountRows = await processorRows([context, entry, exit,
    { ...context, wallTimeMs: stamp + 1, monoMs: 1, fields: { ...context.fields, accountHash: 'd'.repeat(64), mode: 'live' } },
    { event: 'post_exit_quote_input', wallTimeMs: stamp + 2, monoMs: 2, fields: { symbol: 'SPY260924C00770000', bid: 1, receivedAtMs: stamp + 2, receivedMonoMs: 2 } },
  ]);
  assert(changedAccountRows.filter((value) => value.event === 'POST_EXIT_QUOTE').every((value) => value.fields.mode === 'paper' && value.fields.accountHash === 'c'.repeat(64)), 'open window identity is frozen across context changes');

  let now = Date.now();
  const writer = await createEvidenceWriter({ directory: paperDirectory, runId: 'run-a', retentionMs: 30 * 86_400_000, maxTotalBytes: 256 * 1024 * 1024, now: () => now });
  await writer.write(row('window-a', 'POST_EXIT_START', 11_000));
  await writer.write(row('window-a', 'POST_EXIT_QUOTE', 12_000, { sourceTimestampMs: 11_900, receiptTimestampMs: 12_000, bid: 1.1, ask: 1.2 }));
  await writer.write(row('window-a', 'POST_EXIT_END', 41_000, { reason: 'horizon_complete' }));
  await assert.rejects(writer.write(row('window-b', 'POST_EXIT_START', 21_000, { mode: 'live', accountHash: 'd'.repeat(64), tradeId: 'trade-b', exitExecutionId: 'sell-exec-b', exitTimestampMs: 21_000 })), (error) => error.code === 'EVIDENCE_PARTITION_CHANGED');
  await writer.close();

  await mkdir(liveDirectory);
  const liveWriter = await createEvidenceWriter({ directory: liveDirectory, runId: 'run-a' });
  await liveWriter.write(row('window-b', 'POST_EXIT_START', 21_000, { mode: 'live', accountHash: 'd'.repeat(64), tradeId: 'trade-b', exitExecutionId: 'sell-exec-b', exitTimestampMs: 21_000 }));
  await liveWriter.write(row('window-b', 'POST_EXIT_END', 51_000, { mode: 'live', accountHash: 'd'.repeat(64), tradeId: 'trade-b', exitExecutionId: 'sell-exec-b', exitTimestampMs: 21_000, reason: 'horizon_complete' }));
  await liveWriter.close();

  const files = (await readdir(paperDirectory)).filter((name) => name.endsWith('.jsonl'));
  assert.equal(files.length, 1, 'the paper exit window has its own file');
  assert.equal((await readdir(liveDirectory)).filter((name) => name.endsWith('.jsonl')).length, 1, 'live evidence is split into a separate output directory');
  const windows = await Promise.all(files.map(async (name) => (await readFile(join(paperDirectory, name), 'utf8')).trim().split('\n').map(JSON.parse)));
  const first = windows.find((rows) => rows.some((entry) => entry.windowId === 'window-a'));
  assert.deepEqual(first.map((entry) => entry.event), ['POST_EXIT_START', 'POST_EXIT_QUOTE', 'POST_EXIT_END']);
  assert(first.every((entry) => entry.fields.mode === 'paper' && entry.fields.accountHash === 'a'.repeat(64) && entry.fields.tradeId === 'trade-a'));
  assert.equal(first[1].fields.sourceTimestampMs, 11_900, 'source and receipt times remain distinct');
  const liveFiles = (await readdir(liveDirectory)).filter((name) => name.endsWith('.jsonl'));
  const liveRows = (await readFile(join(liveDirectory, liveFiles[0]), 'utf8')).trim().split('\n').map(JSON.parse);
  assert(liveRows.every((entry) => entry.fields.tradeId === 'trade-b' && entry.fields.mode === 'live' && entry.fields.accountHash === 'd'.repeat(64)));

  now += 31 * 86_400_000;
  const aged = await createEvidenceWriter({ directory: paperDirectory, runId: 'run-b', retentionMs: 30 * 86_400_000, maxTotalBytes: 65_536, now: () => now });
  await aged.write({ ...row('window-c', 'POST_EXIT_START', now, { tradeId: 'trade-c', exitExecutionId: 'sell-exec-c', exitTimestampMs: now }), runId: 'run-b' });
  await aged.write({ ...row('window-c', 'POST_EXIT_END', now + 1, { tradeId: 'trade-c', exitExecutionId: 'sell-exec-c', exitTimestampMs: now, reason: 'retention_test' }), runId: 'run-b' });
  await aged.close();
  const retained = (await readdir(paperDirectory)).filter((name) => name.endsWith('.jsonl'));
  assert.equal(retained.length, 1, 'expired window files are removed and their bytes leave the cap accounting');
  const verificationDirectory = join(root, 'verification');
  await mkdir(verificationDirectory, { recursive: true });
  await writeFile(join(verificationDirectory, 'post-exit-sample.jsonl'), await readFile(join(workerDirectory, evidenceFiles[0]), 'utf8'));
  await writeFile(join(verificationDirectory, 'post-exit-complete-synthetic.jsonl'), fullWindowText);
  await writeFile(join(verificationDirectory, 'post-exit-check-report.json'), `${JSON.stringify({
    passed: true,
    command: 'node telemetry/post-exit.check.mjs',
    checks: ['runner fan-out wiring', 'offline order and position-state equivalence', 'actual position_exit join', 'no false queue-loss gap on an unsaturated worker replay', 'worker persistence and shutdown partial status', 'paper/live and account isolation', 'generic trace rotation isolation', 'duplicate exit execution suppression', 'distinct partial exit executions', 'same-batch queue-loss gap', '30-second boundary sample', 'empty-window partial coverage', 'dense quotes and delayed boundary source', 'complete synthetic sampled window', 'stale source timestamp marking', 'frozen mode/account identity', 'whole-file retention expiration and byte recount'],
    output: ['post-exit-sample.jsonl', 'post-exit-complete-synthetic.jsonl'],
  }, null, 2)}\n`);
  console.log('post-exit checks passed; temporary evidence removed');
} finally {
  await rm(root, { recursive: true, force: true });
}
