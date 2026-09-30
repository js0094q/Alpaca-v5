import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTrace, observe } from './trace.mjs';
import { createWriter } from './writer.mjs';
import { createPositions } from '../positions.mjs';
import { createEntry } from '../entry.mjs';
import { createSignal } from '../signal.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--baseline' || !args[1])) throw new Error('Usage: node telemetry/check.mjs [--baseline DIRECTORY]');
const baseline = args.length ? resolve(args[1]) : fileURLToPath(new URL('../../baseline/', import.meta.url));
const { createPositions: originalPositions } = await import(pathToFileURL(join(baseline, 'positions.mjs')));
const { createEntry: originalEntry } = await import(pathToFileURL(join(baseline, 'entry.mjs')));
const { createSignal: originalSignal } = await import(pathToFileURL(join(baseline, 'signal.mjs')));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const until = async (condition, limit = 6000) => { const started = Date.now(); while (!condition()) { assert(Date.now() - started < limit, 'wait exceeded bounded deadline'); await sleep(10); } };
const normalize = (value) => JSON.parse(JSON.stringify(value).replace(/v5-(buy|sell)-[a-f0-9-]{36}/g, 'v5-$1-UUID'));
const observationFields = new Set(['actionSource', 'sourceTradeId', 'receivedAt', 'priorCount', 'priorHigh', 'priorLow', 'tradeSetId', 'signalId', 'entrySetId', 'anchorSetAtMs', 'anchorSourceTimestamp', 'quoteReceivedAtMs', 'quoteReceivedMonoMs', 'premiumPnlPerShare', 'contractSize', 'contractSizeSource', 'realizedPnlUsd']);
const decisionProjection = (value) => Array.isArray(value) ? value.map(decisionProjection) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => !observationFields.has(key) && !(key === 'entryPrice' && 'executionId' in value && 'qty' in value)).map(([key, item]) => [key, decisionProjection(item)])) : value;
const temp = await mkdtemp(join(tmpdir(), 'v5-active-trace-'));
const checks = [];
const loadRows = async (directory) => (await Promise.all((await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort().map((name) => readFile(join(directory, name), 'utf8')))).join('').trim().split('\n').filter(Boolean).map(JSON.parse);

async function lifecycle(positionsFactory, entryFactory, telemetry, signalFactory = createSignal) {
  const result = [];
  let scenarioIndex = 0;
  for (const [name, quotes] of [
    ['loss', [[1000, 1.01], [9999, 0.89], [10000, 0.89], [10100, 0.89], [10200, 0.89]]],
    ['floor', [[10000, 1.00], [10100, 1.00], [10200, 1.05], [10300, 1.08], [10400, 1.07]]],
    ['ceiling', [[10000, 1.10], [10100, 1.10], [10200, 1.20]]],
  ]) {
    const base = Date.parse('2026-09-24T14:00:00Z') + scenarioIndex++ * 180000;
    let wall = base, sequence = 0;
    const calls = [], exits = [], states = [];
    const broker = {
      async submitOrder(order) { calls.push(['submit', order]); return { id: `order-${++sequence}`, status: 'accepted' }; },
      async replaceOrder(id, order) { calls.push(['replace', id, order]); return { id: `order-${++sequence}`, status: 'accepted' }; },
      async cancelOrder(id) { calls.push(['cancel', id]); },
    };
    const positions = positionsFactory({ broker, telemetry, now: () => wall, nowMono: () => wall, onExit: (row) => exits.push(row), onState: (row) => states.push(row) });
    const symbol = 'SPY260924C00770000';
    let entryAsk = 1.02;
    const entry = entryFactory({ broker, telemetry, getContracts: async () => [{ symbol, strike: 770 }], getQuote: async () => ({ symbol, bid: 1, ask: entryAsk, timestamp: wall }), onFill: positions.onFill, nowMono: () => wall });
    let pendingEntry;
    const signal = signalFactory({ telemetry, onBreakout: (event) => { pendingEntry = entry.onBreakout(event); } });
    signal.setSession({ date: '2026-09-24', open: '2026-09-24T13:30:00Z', close: '2026-09-24T20:00:00Z' });
    signal.reset(base - 30000);
    signal.onTrade({ tradeId: `${name}-prior-1`, timestamp: base - 2000, price: 769.98 }, base - 2000);
    signal.onTrade({ tradeId: `${name}-prior-2`, timestamp: base - 1000, price: 769.98 }, base - 1000);
    signal.onTrade({ tradeId: `${name}-trigger`, timestamp: base, price: 770 }, base);
    assert(pendingEntry, 'Actual signal path must produce the entry breakout');
    await pendingEntry;
    const buy = entry.getState();
    entry.onOrderUpdate({ orderId: buy.orderId, clientOrderId: buy.clientOrderId, event: 'partial_fill', executionId: `buy-${name}-part1`, fillQty: 1, fillPrice: 1, timestamp: wall });
    assert.equal(entry.getState().remainingQty, 2);
    assert.equal(entry.getState().deadline, base + 5000);
    wall = base + 100; entryAsk = 1.03; entry.tick(); await settle();
    const repricedBuy = entry.getState();
    assert.notEqual(repricedBuy.orderId, buy.orderId);
    entry.onOrderUpdate({ orderId: repricedBuy.orderId, clientOrderId: buy.clientOrderId, event: 'fill', executionId: `buy-${name}-part2`, fillQty: 2, fillPrice: 1, timestamp: wall });
    assert.equal(entry.getState().remainingQty, 0);
    await settle();
    for (const [age, bid] of quotes) { wall = base + age; positions.onQuote({ symbol, bid, ask: bid + 0.01, timestamp: wall }); await settle(); }
    assert(positions.getTrades().every((trade) => trade.sellLatched));
    for (const trade of positions.getTrades()) {
      positions.onOrderUpdate({ orderId: trade.orderId, clientOrderId: trade.logicalSellId, event: 'fill', executionId: `exit-${trade.tradeId}`, fillQty: 1, fillPrice: quotes.at(-1)[1], timestamp: wall });
      await settle();
    }
    assert(positions.getTrades().every((trade) => trade.remainingQty === 0));
    result.push(normalize(decisionProjection({ name, calls, exits, states, final: positions.getTrades(), entry: entry.getState() })));
  }
  return result;
}

const quantiles = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { unit: 'microseconds', n: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / sorted.length, p50: sorted[Math.floor(sorted.length * 0.50)], p95: sorted[Math.floor(sorted.length * 0.95)], p99: sorted[Math.floor(sorted.length * 0.99)] };
};

try {
  const disabled = createTrace({ enabled: false });
  // Same URL argument shape passed by paper.mjs; failure here must block deployment.
  const trace = createTrace({ directory: new URL(`file://${join(temp, 'lifecycle')}/`) });
  const invalidTraceFields = [];
  const emitTrace = (event, fields) => {
    for (const [key, value] of Object.entries(fields ?? {})) if (value !== undefined && !(value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value))) invalidTraceFields.push({ event, key, type: typeof value });
    return trace.emit(event, fields);
  };
  const original = await lifecycle(originalPositions, originalEntry, undefined, originalSignal);
  assert.deepEqual(await lifecycle(createPositions, createEntry, disabled.emit), original);
  assert.deepEqual(await lifecycle(createPositions, createEntry, emitTrace), original);
  assert.deepEqual(await lifecycle(createPositions, createEntry, () => { throw new Error('observer failed'); }), original);
  assert.equal(trace.status().truncated, 0, 'decision telemetry fits the bounded writer limits');
  trace.emit('primitive_limits', { long: 'x'.repeat(300), object: { ignored: true }, ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field${i}`, i])) });
  trace.stop(); await until(() => trace.status().stopped);
  assert.equal(trace.status().failed, false); assert.equal(trace.status().dropped, 0);
  assert.deepEqual(invalidTraceFields, []);
  const rows = await loadRows(join(temp, 'lifecycle'));
  const defaultHeader = rows.find((row) => row.event === 'TRACE_SEGMENT_START');
  assert.equal(defaultHeader.fields.maxBytes, 64 * 1024 * 1024);
  assert.equal(defaultHeader.fields.maxSegments, 256);
  const directDefault = await createWriter({ directory: join(temp, 'default-writer'), runId: 'abc123' });
  await directDefault.close();
  const [directHeader] = await loadRows(join(temp, 'default-writer'));
  assert.equal(directHeader.fields.maxBytes, defaultHeader.fields.maxBytes);
  assert.equal(directHeader.fields.maxSegments, defaultHeader.fields.maxSegments);
  checks.push('Trace and standalone writer both default to 256x64MiB (16GiB) retention');
  const primitive = rows.find((row) => row.event === 'primitive_limits');
  assert.equal(primitive.fields.long.length, 256); assert.equal(primitive.fields.object, undefined); assert.equal(Object.keys(primitive.fields).length, 32);
  for (const action of ['HOLD', 'LOSS_SUPPRESSED_BY_GRACE', 'LOSS_LATCH', 'ARM_5C', 'REARM_8C', 'PROFIT_FLOOR_LATCH', 'CEILING_10C']) assert(rows.some((row) => row.event === 'lot_decision' && row.fields.action === action), action);
  assert.equal(rows.filter((row) => row.event === 'position_exit').length, 9);
  assert(rows.some((row) => row.event === 'entry_state' && row.fields.orderStatus === 'partial_fill'));
  assert.equal(rows.filter((row) => row.event === 'buy_reprice').length, 3);
  const fillLinks = rows.filter((row) => row.event === 'entry_fill_link');
  assert.equal(fillLinks.length, 9);
  const ranges = rows.filter((row) => row.event === 'signal_range');
  assert.equal(ranges.length, 3);
  for (const range of ranges) {
    assert.equal(range.fields.windowMs, 30000); assert.equal(range.fields.priorHigh, 769.98); assert.equal(range.fields.priorLow, 769.98); assert.equal(range.fields.priorCount, 2);
    const selection = rows.find((row) => row.event === 'signal_accepted_for_selection' && row.fields.signalKey === range.fields.signalKey);
    assert(selection?.fields.signalId);
    const set = rows.find((row) => row.event === 'entry_set' && row.fields.signalId === selection.fields.signalId && row.fields.signalTimestamp === range.fields.sourceTimestamp);
    assert(set?.fields.entrySetId);
    assert.equal(fillLinks.filter((link) => link.fields.entrySetId === set.fields.entrySetId).length, 3);
  }
  for (const link of fillLinks) {
    assert(link.fields.signalId && link.fields.entrySetId && link.fields.tradeId);
    assert(rows.some((row) => row.event === 'sell_latch' && row.fields.tradeId === link.fields.tradeId && row.fields.logicalSellId));
    const exits = rows.filter((row) => row.event === 'position_exit' && row.fields.tradeId === link.fields.tradeId);
    assert.equal(exits.reduce((sum, row) => sum + row.fields.quantity, 0), 1);
    assert.equal(exits.at(-1).fields.remainingQty, 0);
  }
  checks.push('Signal-driven baseline vs disabled/enabled/throwing-observer order/state parity; 30-second range joined through selection/entry set; BUY partial1 then2 with repricing and grace/suppression/loss, 5c/8c/floor/10c; 9 whole-contract lots and9 SELLfills reconstructed');

  const stalledUrl = new URL(`data:text/javascript,${encodeURIComponent("import {parentPort} from 'node:worker_threads'; parentPort.postMessage({type:'ready'}); setInterval(()=>{},1000);")}`);
  const stalled = createTrace({ directory: join(temp, 'stalled'), capacity: 8, batchSize: 2, flushMs: 10, shutdownMs: 100, workerUrl: stalledUrl });
  await until(() => stalled.status().ready);
  for (let i = 0; i < 100; i++) stalled.emit('saturation', { i });
  await sleep(30);
  assert(stalled.status().queued <= 8 && stalled.status().inFlight <= 2 && stalled.status().dropped >= 92);
  const stalledBefore = stalled.status();
  assert.deepEqual(await lifecycle(createPositions, createEntry, stalled.emit), original);
  stalled.stop(); await until(() => stalled.status().stopped);
  assert.equal(stalled.status().failure, 'SHUTDOWN_TIMEOUT');
  checks.push(`Saturation/stalled worker contained: queue<=8, in-flight<=2, initial dropped=${stalledBefore.dropped}; identical trading decisions; bounded shutdown`);

  const badParent = join(temp, 'file-parent'); await writeFile(badParent, 'regular file');
  const failed = createTrace({ directory: join(badParent, 'child') });
  failed.emit('before_failure', {}); await until(() => failed.status().failed);
  assert.deepEqual(await lifecycle(createPositions, createEntry, failed.emit), original);
  const exitUrl = new URL('data:text/javascript,process.exit(7)');
  const killed = createTrace({ directory: join(temp, 'worker-exit'), workerUrl: exitUrl });
  await until(() => killed.status().failed); assert.equal(killed.status().failure, 'WORKER_EXIT_7');
  observe(() => { throw new Error('failed'); }, 'contained', {});
  checks.push('Writer mkdir failure and independent worker termination contained; enabled trading remains identical; no retries or bot process operations');

  const writer = await createWriter({ directory: join(temp, 'rotation'), runId: 'abc123', maxBytes: 2048, maxSegments: 3 });
  for (let i = 0; i < 100; i++) await writer.write({ event: 'sample', sequence: i, fields: { value: 'x'.repeat(150) } });
  await writer.close();
  const files = (await readdir(join(temp, 'rotation'))).filter((name) => name.endsWith('.jsonl'));
  assert(files.length <= 3);
  for (const file of files) assert((await stat(join(temp, 'rotation', file))).size <= 2048);
  assert((await loadRows(join(temp, 'rotation'))).some((row) => row.fields?.removedCount > 0));
  checks.push('Append-only JSONL rotation <=3x2048 bytes with explicit retention deletion evidence');

  const measure = (callback, n = 1000) => { const samples = []; for (let i = 0; i < n; i++) { const t = performance.now(); callback(i); samples.push((performance.now() - t) * 1000); } return quantiles(samples); };
  const bench = createTrace({ directory: join(temp, 'benchmark'), capacity: 8192, batchSize: 128, flushMs: 10 });
  await until(() => bench.status().ready);
  const emitterFields = { tradeId: 'representative-lot', symbol: 'SPY260924C00770000', bid: 1.02, entryPrice: 1, graceActive: true, ageMs: 20000, remainingQty: 1 };
  const emitter = { disabled: measure(() => disabled.emit('lot_decision', emitterFields)), enabled: measure(() => bench.emit('lot_decision', emitterFields)) };
  await until(() => bench.status().queued === 0 && bench.status().inFlight === 0);
  function quoteBenchmark(factory, emit) {
    let wall = 100000;
    const positions = factory({ broker: {}, telemetry: emit, now: () => wall });
    for (let i = 1; i <= 3; i++) positions.onFill({ tradeId: `benchmark:${i}`, executionId: 'benchmark', symbol: 'SPY', entryPrice: 1, timestamp: wall });
    return measure((i) => { wall = 100000 + i * 20; positions.onQuote({ symbol: 'SPY', bid: 1.01 + (i % 3) * 0.01, ask: 1.04, timestamp: wall }); });
  }
  // A distinct warmup reduces first-call effects; this is an offline microbenchmark, not a latency guarantee.
  quoteBenchmark(originalPositions); quoteBenchmark(createPositions, disabled.emit);
  const quotes = { baseline: quoteBenchmark(originalPositions), disabled: quoteBenchmark(createPositions, disabled.emit), enabled: quoteBenchmark(createPositions, bench.emit) };
  assert.equal(bench.status().dropped, 0);
  bench.stop(); await until(() => bench.status().stopped);
  const benchmark = { emitter, threeLotQuoteEvaluation: quotes,
    enabledVsBaselineMeanRatio: quotes.enabled.mean / quotes.baseline.mean,
    enabledVsDisabledMeanRatio: quotes.enabled.mean / quotes.disabled.mean,
    benchmarkQueue: { capacity: 8192, batchSize: 128, flushMs: 10 }, note: 'Synchronous callback costs only, finite offline run; excludes live network and disk latency. All benchmark events accepted; writer separate.' };
  const evidence = new URL('./evidence/', import.meta.url);
  await mkdir(evidence, { recursive: true });
  await writeFile(new URL('representative.jsonl', evidence), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(new URL('reconstruction.json', evidence), JSON.stringify({ source: 'deterministic mocked broker replay, not live trading', signals: ranges.map((range) => ({ ...range.fields, selection: rows.find((row) => row.event === 'signal_accepted_for_selection' && row.fields.signalKey === range.fields.signalKey)?.fields })), lots: fillLinks.map((link) => ({ ...link.fields, acceptedQuotes: rows.filter((row) => row.event === 'position_quote_accepted' && row.fields.tradeId === link.fields.tradeId).map((row) => row.fields), decisions: rows.filter((row) => row.event === 'lot_decision' && row.fields.tradeId === link.fields.tradeId).map((row) => row.fields), exits: rows.filter((row) => row.event === 'position_exit' && row.fields.tradeId === link.fields.tradeId).map((row) => row.fields) })) }, null, 2) + '\n');
  const report = { ok: true, checks, lifecycleRecords: rows.length, benchmark };
  await writeFile(new URL('check-report.json', evidence), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(temp, { recursive: true, force: true }); }
