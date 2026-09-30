import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBrokerReconciler, executionLinks, tools as reconcileTools } from './reconcile.mjs';
import { tools as brokerTools } from './broker.mjs';
import { tools as runtimeTools } from './runtime.mjs';
import { PAPER_ACCOUNT_ID } from './config.mjs';
import { createPostExitProcessor } from '../telemetry/post-exit-worker.mjs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrace } from '../telemetry/trace.mjs';
import { createSignal } from '../signal.mjs';
import { createEntry } from '../entry.mjs';
import { createPositions } from '../positions.mjs';

const symbol = 'SPY260926C00660000';
const accountId = PAPER_ACCOUNT_ID;
const executionId = 'cf051a15-72f6-48ad-8c44-b4c49b6ec94b';
const exitExecutionId = '4c59a16d-c863-44f8-9ac3-3cfae9c3f260';
const accountHash = createHash('sha256').update(accountId).digest('hex');
const envelope = (data, path) => ({ ok: true, status: 200, request: { method: 'GET', path }, data });
const telemetrySnapshot = (events) => ({ status: 'available', files: [{ name: 'fixture.jsonl', events, truncated: false }], historicalPaper: { status: 'available', account: 'unknown_historical_account', files: [] } });
const baseLocal = (overrides = {}) => ({ mode: 'paper', capturedAt: '2026-09-26T14:00:00.000Z', accountHash,
  continuity: { status: 'available', trades: [{ tradeId: 't1', executionId, symbol, entryPrice: 1, remainingQty: 1, sellLatched: false, logicalSellId: null, orderId: null }] },
  ledger: { status: 'available', events: [
    `[2026-09-26T14:00:00.000Z] FILL tradeId=t1 executionId=${executionId} symbol=${symbol} entryPrice=1`,
    `[2026-09-26T14:00:01.000Z] EXIT tradeId=closed executionId=${exitExecutionId} symbol=${symbol} qty=1 price=0.44`,
  ] },
  telemetry: telemetrySnapshot([]), entry: { status: 'unavailable', orderId: null, clientOrderId: null },
  ...overrides,
});
const baseBroker = (overrides = {}) => ({
  mode: 'paper', capturedAt: '2026-09-26T14:01:00.000Z',
  account: envelope({ id: accountId }, '/v2/account'),
  orders: envelope([], '/v2/orders?status=all'),
  openOrders: envelope([], '/v2/orders?status=open'),
  fills: envelope([
    { id: `20260925151546216::${executionId}`, symbol, qty: '1', side: 'buy' },
    { id: `20260925154546216::${exitExecutionId}`, symbol, qty: '1', side: 'sell', price: '0.44' },
  ], '/v2/account/activities/FILL'),
  positions: envelope([{ symbol, qty: '1' }], '/v2/positions'),
  ordersMayBeTruncated: false, fillsMayBeTruncated: false,
  ...overrides,
});

const run = (broker, local, getRequest = async () => { throw new Error('unexpected broker lookup'); }) => createBrokerReconciler({
  getBrokerSnapshot: async () => broker,
  getLocalSnapshot: async () => local,
  getRequest,
});

// A complete, matching continuity + ledger + broker view is reported as matched.
const normal = await run(baseBroker(), baseLocal())();
assert.equal(normal.status, 'matched');
assert.equal(normal.local.ledger.status, 'matched');
assert.equal(normal.broker.fills.status, 200);
const historicalOnly = await run(baseBroker(), baseLocal({ telemetry: { status: 'available', files: [], historicalPaper: { status: 'available', account: 'unknown_historical_account', files: [{ events: [JSON.stringify({ event: 'entry_state', fields: { entrySetId: 'historical-buy', state: 'UNKNOWN_OUTCOME', orderStatus: 'UNKNOWN_OUTCOME' } })] }] } } }))();
assert.equal(historicalOnly.unknownBuyOutcomes.length, 0, 'unknown-account historical traces cannot resolve the selected account');

// Alpaca activity IDs carry a timestamp prefix; one aggregated broker fill can back three V5 unit records.
const aggregateId = 'f3a0f78d-c359-4c1b-9684-24b4455a67ae';
const aggregateLocal = baseLocal({ continuity: { status: 'available', trades: [1, 2, 3].map((unit) => ({ tradeId: `batch:${unit}`, executionId: aggregateId, symbol, entryPrice: 1, remainingQty: 1, sellLatched: false, logicalSellId: null, orderId: null })) }, ledger: { status: 'available', events: [1, 2, 3].map((unit) => `[2026-09-26T14:00:00.000Z] FILL tradeId=batch:${unit} executionId=${aggregateId} symbol=${symbol} entryPrice=1`) } });
const aggregateBroker = baseBroker({ fills: envelope([{ id: `20260925151546216::${aggregateId}`, symbol, qty: '3', side: 'buy' }], '/v2/account/activities/FILL'), positions: envelope([{ symbol, qty: '3' }], '/v2/positions') });
const aggregate = await run(aggregateBroker, aggregateLocal)();
assert.equal(aggregate.local.ledger.status, 'matched');

// A rejected BUY remains visible with the broker error details from V5 telemetry.
const rejectedTelemetry = [
  JSON.stringify({ event: 'buy_api_error', fields: { entrySetId: 'v5-buy-rejected', httpStatus: 403, code: '40310000', message: 'insufficient options buying power' } }),
  JSON.stringify({ event: 'entry_state', fields: { entrySetId: 'v5-buy-rejected', state: 'DONE', orderStatus: 'rejected' } }),
];
const rejected = await run(baseBroker({ orders: envelope([{ id: 'buy-r', client_order_id: 'v5-buy-rejected', side: 'buy', status: 'rejected', reject_reason: 'insufficient_options_buying_power' }], '/v2/orders') }), baseLocal({ telemetry: telemetrySnapshot(rejectedTelemetry) }))();
assert.deepEqual(rejected.buyErrors[0], { clientOrderId: 'v5-buy-rejected', orderId: null, httpStatus: 403, code: '40310000', message: 'insufficient options buying power' });

// UNKNOWN_OUTCOME resolves with one read by client order ID and never submits.
const unknownTelemetry = [
  JSON.stringify({ event: 'buy_api_error', fields: { entrySetId: 'v5-buy-unknown', httpStatus: null, code: 'NETWORK_ERROR', message: 'Request failed; mutation outcome may be unknown.' } }),
  JSON.stringify({ event: 'entry_state', fields: { entrySetId: 'v5-buy-unknown', state: 'UNKNOWN_OUTCOME', orderStatus: 'UNKNOWN_OUTCOME' } }),
];
let lookupCall;
const unknown = await run(baseBroker(), baseLocal({ telemetry: telemetrySnapshot(unknownTelemetry) }), async (...args) => {
  lookupCall = args;
  return envelope({ id: 'buy-unknown', client_order_id: 'v5-buy-unknown', side: 'buy', status: 'accepted' }, args[0]);
})();
assert.deepEqual(lookupCall, ['/v2/orders:by_client_order_id?client_order_id=v5-buy-unknown']);
assert.deepEqual(unknown.unknownBuyOutcomes[0].resolution, { orderId: 'buy-unknown', status: 'accepted', clientOrderId: 'v5-buy-unknown' });
assert.equal(unknown.unknowns.some((item) => item.code === 'BUY_OUTCOME_UNRESOLVED'), false);

// A replaced SELL parent and its active successor count once by lineage.
const replacementOrders = [
  { id: 'sell-old', client_order_id: 'logical-sell-1', symbol, side: 'sell', qty: '1', status: 'replaced', replaced_by: 'sell-new' },
  { id: 'sell-new', client_order_id: 'logical-sell-1', symbol, side: 'sell', qty: '1', status: 'new', replaces: 'sell-old' },
];
const replacement = await run(baseBroker({ orders: envelope(replacementOrders, '/v2/orders'), openOrders: envelope([replacementOrders[1]], '/v2/orders?status=open') }), baseLocal({ continuity: { status: 'available', trades: [{ tradeId: 't1', executionId, symbol, entryPrice: 1, remainingQty: 1, sellLatched: true, logicalSellId: 'logical-sell-1', orderId: 'sell-old' }] } }))();
assert.equal(replacement.discrepancies.some((item) => item.code === 'EXCESS_SELL' || item.code === 'UNLINKED_SELL_ORDER'), false);

const excessOrders = [...replacementOrders, { id: 'sell-extra', client_order_id: 'other', symbol, side: 'sell', qty: '1', status: 'new' }];
const excess = await run(baseBroker({ orders: envelope(excessOrders, '/v2/orders'), openOrders: envelope([replacementOrders[1], excessOrders[2]], '/v2/orders?status=open') }), baseLocal({ continuity: { status: 'available', trades: [{ tradeId: 't1', executionId, symbol, entryPrice: 1, remainingQty: 1, sellLatched: true, logicalSellId: 'logical-sell-1', orderId: 'sell-old' }] } }))();
assert.ok(excess.discrepancies.some((item) => item.code === 'EXCESS_SELL' && item.openSellQuantity === 2));
assert.ok(excess.discrepancies.some((item) => item.code === 'UNLINKED_SELL_ORDER' && item.orderId === 'sell-extra'));

// Broker exposure hazards are still diagnosed if local continuity is absent.
const short = await run(baseBroker({ positions: envelope([{ symbol, qty: '-1' }], '/v2/positions') }), { mode: 'paper', accountHash, continuity: { status: 'missing', trades: [] }, ledger: { status: 'missing', events: [] }, telemetry: [] })();
assert.ok(short.discrepancies.some((item) => item.code === 'UNINTENDED_SHORT' && item.quantity === -1));
assert.equal(short.status, 'unknown');

// FILL-to-activity evidence remains useful without continuity; active ownership stays unknown.
const missingContinuity = await run(baseBroker({ fills: envelope([{ id: `20260925151546216::${executionId}`, symbol, qty: '2', side: 'buy' }], '/v2/account/activities/FILL') }), baseLocal({ continuity: { status: 'missing', trades: [] } }))();
assert.ok(missingContinuity.discrepancies.some((item) => item.code === 'LEDGER_BROKER_FILL_MISMATCH'));
assert.equal(missingContinuity.status, 'unknown');

// Missing broker data and unresolved uncertain outcomes stay unknown.
const incomplete = await run(baseBroker({ fills: { ok: false, status: 503, request: { method: 'GET', path: '/fills' }, error: { code: 'UPSTREAM_ERROR', message: 'temporarily unavailable' } } }), baseLocal())();
assert.equal(incomplete.status, 'unknown');
assert.equal(incomplete.broker.fills.status, 503);

// Public reconcile exposes no account selector; all broker and local reads are PAPER-bound.
assert.deepEqual(reconcileTools[0].inputSchema, { type: 'object', properties: {}, additionalProperties: false });
assert.ok(!Object.hasOwn(reconcileTools[1].inputSchema.properties, 'mode'));
for (const tool of [...brokerTools, ...runtimeTools, ...reconcileTools]) assert.ok(!Object.hasOwn(tool.inputSchema.properties ?? {}, 'mode'), `${tool.name} must not expose account mode`);
let readCount = 0;
const paperOnly = createBrokerReconciler({
  getBrokerSnapshot: async () => { readCount++; return baseBroker(); },
  getLocalSnapshot: async (mode) => { assert.equal(mode, 'paper'); readCount++; return baseLocal(); },
});
assert.equal((await paperOnly()).status, 'matched', 'deterministic PAPER fixture reconciles without a public mode argument');
assert.equal(readCount, 2);

const links = executionLinks(baseLocal(), baseBroker());
assert.equal(links[0].match, 'execution_id_symbol_side');
assert.equal(links[0].tradeId, 't1');
assert.equal(links[0].brokerActivityId, `20260925151546216::${executionId}`);
assert.equal(links[0].signal, null, 'missing signal must remain unknown');
const trace = [
  { runId: 'other', event: 'signal_accepted_for_selection', fields: { signalId: 'signal-1', direction: 'CALL' } },
  { runId: 'correct', event: 'signal_accepted_for_selection', fields: { signalId: 'signal-1', direction: 'PUT' } },
  { runId: 'correct', event: 'entry_fill_link', fields: { tradeId: 't1', executionId, symbol, signalId: 'signal-1', entrySetId: 'entry-1' } },
];
assert.equal(executionLinks(baseLocal(), baseBroker(), trace)[0].signal.direction, 'PUT', 'signal IDs are scoped to their trace run');
// Run the actual signal -> entry -> positions lifecycle with a deterministic
// in-memory broker, persist its emitted trace, then run post-exit and autopsy.
const autopsyTraceDirectory = await mkdtemp(join(tmpdir(), 'v5-lane4-autopsy-'));
const sourceTraceEmitter = createTrace({ directory: autopsyTraceDirectory, flushMs: 10 });
const simulatedRunId = sourceTraceEmitter.status().runId;
const entryExecutionId = '11111111-1111-4111-8111-111111111111';
const exitExecutionIds = ['22222222-2222-4222-8222-222222222221', '22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222223'];
const traceTelemetry = sourceTraceEmitter.emit;
const baseMs = Date.parse('2026-09-25T13:32:00.000Z');
let currentMs = baseMs;
let brokerOrderSeq = 0;
const fakeBroker = {
  async submitOrder(order) { return { id: `${order.side}-fixture-${++brokerOrderSeq}`, status: 'accepted' }; },
  async replaceOrder(_id, order) { return { id: `replace-fixture-${++brokerOrderSeq}`, status: 'accepted', ...order }; },
  async cancelOrder() {},
};
const positions = createPositions({ broker: fakeBroker, telemetry: traceTelemetry, now: () => currentMs, nowMono: () => currentMs });
const entry = createEntry({ broker: fakeBroker, telemetry: traceTelemetry,
  getContracts: async () => [{ symbol, strike: 660, contractSize: 100 }],
  getQuote: async () => ({ symbol, bid: 1, ask: 1.01, timestamp: new Date(baseMs).toISOString() }),
  onFill: (fill) => positions.onFill(fill), nowMono: () => currentMs });
let pendingEntry;
const signal = createSignal({ telemetry: traceTelemetry, onBreakout: (event) => { pendingEntry = entry.onBreakout(event); } });
const sessionOpen = baseMs - 120_000;
signal.setSession({ date: '2026-09-25', open: sessionOpen, close: Date.parse('2026-09-25T20:00:00.000Z') });
signal.reset(sessionOpen - 30_000);
signal.onTrade({ tradeId: 'fixture-prior-1', timestamp: sessionOpen + 118_000, price: 659.98 }, baseMs);
signal.onTrade({ tradeId: 'fixture-prior-2', timestamp: sessionOpen + 119_000, price: 659.98 }, baseMs);
signal.onTrade({ tradeId: 'fixture-trigger', timestamp: baseMs, price: 660 }, baseMs);
assert.ok(pendingEntry, 'production signal module produces the entry breakout');
await pendingEntry;
const submittedEntry = entry.getState();
entry.onOrderUpdate({ orderId: submittedEntry.orderId, clientOrderId: submittedEntry.clientOrderId,
  event: 'fill', executionId: entryExecutionId, fillQty: 3, fillPrice: 1, timestamp: new Date(baseMs).toISOString() });
const actualTrades = positions.getTrades();
assert.equal(actualTrades.length, 3, 'production entry fill creates three position lots');
currentMs = baseMs + 10_000;
positions.onQuote({ symbol, bid: 1, ask: 1.01, timestamp: new Date(currentMs).toISOString() });
currentMs += 1_000;
positions.onQuote({ symbol, bid: 1.05, ask: 1.06, timestamp: new Date(currentMs).toISOString() });
currentMs += 1_000;
positions.onQuote({ symbol, bid: 1.04, ask: 1.05, timestamp: new Date(currentMs).toISOString() });
await new Promise((resolve) => setImmediate(resolve));
const exitTimestamp = new Date(currentMs + 1).toISOString();
for (const [index, trade] of positions.getTrades().entries()) {
  positions.onOrderUpdate({ orderId: trade.orderId, clientOrderId: trade.logicalSellId, event: 'fill',
    executionId: exitExecutionIds[index], fillQty: 1, fillPrice: 1.25, timestamp: exitTimestamp });
}
sourceTraceEmitter.stop();
const writerDeadline = Date.now() + 5_000;
while (!sourceTraceEmitter.status().stopped && Date.now() < writerDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(sourceTraceEmitter.status().stopped, true, 'simulated source events persist through the production trace writer');
const sourceTraceFiles = await readdir(autopsyTraceDirectory);
const autopsySourceTrace = (await Promise.all(sourceTraceFiles.filter((name) => name.endsWith('.jsonl')).map((name) => readFile(join(autopsyTraceDirectory, name), 'utf8'))))
  .join('').trim().split('\n').filter(Boolean).map(JSON.parse).filter((row) => !row.event.startsWith('TRACE_')).sort((a, b) => a.sequence - b.sequence);
const actualEntryEvents = autopsySourceTrace.filter((row) => row.event === 'entry_fill_link');
assert.equal(actualEntryEvents.length, 3);
assert.ok(actualEntryEvents.every((row) => row.fields.signalId && row.fields.tradeSetId === submittedEntry.clientOrderId
  && row.fields.entrySetId === submittedEntry.clientOrderId && row.fields.actionSource === 'V5_AUTO'), 'actual entry events preserve full lineage');
assert.ok(autopsySourceTrace.some((row) => row.event === 'contract_candidate' && row.fields.sourceTimestamp), 'actual contract candidate retains quote timestamp');
assert.ok(autopsySourceTrace.some((row) => row.event === 'position_quote_accepted' && Number.isFinite(row.fields.receivedAt)
  && Number.isFinite(row.fields.receivedMonoMs)), 'actual position quotes preserve source and receipt timing');
assert.ok(autopsySourceTrace.some((row) => row.event === 'position_exit' && row.fields.executionId === exitExecutionIds[0]
  && row.fields.tradeSetId === submittedEntry.clientOrderId), 'actual exits preserve lot, set, and execution lineage');
const autopsyLocal = { ledger: { events: [
  `[2026-09-26T14:00:00Z] FILL tradeId=autopsy-lot executionId=${executionId} symbol=${symbol} qty=2 entryPrice=1`,
  `[2026-09-26T14:00:01Z] EXIT tradeId=autopsy-lot executionId=${exitExecutionId} symbol=${symbol} qty=2 price=1.25`,
] }, continuity: { status: 'available', trades: [{ tradeId: 'autopsy-lot', symbol, remainingQty: 0, contractSize: 100 }] } };
const autopsyBroker = baseBroker({
  orders: envelope([{ id: 'buy-order', client_order_id: 'v5-buy-autopsy' }], '/v2/orders'),
  fills: envelope([
    { id: `20260925151546216::${executionId}`, order_id: 'buy-order', symbol, qty: '2', side: 'buy', price: '1.00' },
    { id: `20260925154546216::${exitExecutionId}`, order_id: 'sell-order', symbol, qty: '2', side: 'sell', price: '1.25' },
  ], '/v2/account/activities/FILL'),
});
const emittedPostExitRows = [];
const actualExits = autopsySourceTrace.filter((row) => row.event === 'position_exit');
const exitMs = actualExits[0].wallTimeMs;
const exitMonoMs = actualExits[0].monoMs;
const actualExitTimestampMs = Date.parse(actualExits[0].fields.brokerTimestamp);
const postExitProcessor = createPostExitProcessor({ write: async (row) => emittedPostExitRows.push(row), runId: simulatedRunId, nowMono: () => exitMonoMs + 30_000 });
await postExitProcessor.accept({ event: 'post_exit_context', wallTimeMs: exitMs, monoMs: exitMonoMs, fields: { mode: 'paper', accountHash: 'a'.repeat(64), sessionDate: '2026-09-25' } });
for (const row of autopsySourceTrace) await postExitProcessor.accept(row);
await postExitProcessor.accept({ event: 'post_exit_quote_input', wallTimeMs: exitMs + 1_000, monoMs: exitMonoMs + 1_000, fields: { symbol, bid: 1.3, ask: 1.31, sourceTimestamp: new Date(actualExitTimestampMs + 1_000).toISOString(), sourceTimestampMs: actualExitTimestampMs + 1_000, receivedAtMs: exitMs + 1_000, receivedMonoMs: exitMonoMs + 1_000 } });
await postExitProcessor.accept({ event: 'post_exit_quote_input', wallTimeMs: exitMs + 30_000, monoMs: exitMonoMs + 30_000, fields: { symbol, bid: 1.4, ask: 1.41, sourceTimestamp: new Date(actualExitTimestampMs + 30_000).toISOString(), sourceTimestampMs: actualExitTimestampMs + 30_000, receivedAtMs: exitMs + 30_000, receivedMonoMs: exitMonoMs + 30_000 } });
await postExitProcessor.stop();
const autopsyPostExitTrace = emittedPostExitRows.map((row, sequence) => ({ ...row, runId: simulatedRunId, sequence }));
const autopsyTrace = [...autopsySourceTrace, ...autopsyPostExitTrace];
const brokerFills = [
  { id: `20260925133200000::${entryExecutionId}`, order_id: submittedEntry.orderId, symbol, qty: '3', side: 'buy', price: '1.00' },
  ...exitExecutionIds.map((id, index) => ({ id: `20260925133213000::${id}`, order_id: actualTrades[index].orderId, symbol, qty: '1', side: 'sell', price: '1.25' })),
];
const actualLedgerEvents = [
  ...actualEntryEvents.map((row) => `[2026-09-25T13:32:00.000Z] FILL tradeId=${row.fields.tradeId} executionId=${row.fields.executionId} symbol=${row.fields.symbol} qty=1 entryPrice=${row.fields.entryPrice}`),
  ...actualExits.map((row) => `[2026-09-25T13:32:13.000Z] EXIT tradeId=${row.fields.tradeId} executionId=${row.fields.executionId} symbol=${row.fields.symbol} qty=${row.fields.quantity} price=${row.fields.price}`),
];
const autopsyLocal = { ...baseLocal(), accountHash, ledger: { status: 'available', truncated: false, events: actualLedgerEvents }, continuity: { status: 'available', trades: actualTrades.map((trade) => ({ ...trade, remainingQty: 0, contractSize: 100 })) }, telemetry: telemetrySnapshot(autopsyTrace) };
autopsyLocal.postExitEvidence = { status: 'available', accountHash, windows: actualExits.map((row) => ({ tradeId: row.fields.tradeId, entrySetId: submittedEntry.clientOrderId, entryExecutionId,
  exitExecutionId: row.fields.executionId, symbol, status: 'complete', coverage: { sampled: true }, events: autopsyPostExitTrace.filter((event) => event.fields.tradeId === row.fields.tradeId) })) };
const actualBroker = baseBroker({ orders: envelope([{ id: submittedEntry.orderId, client_order_id: submittedEntry.clientOrderId, symbol, side: 'buy', qty: '3', status: 'filled' },
  ...actualTrades.map((trade) => ({ id: trade.orderId, client_order_id: trade.logicalSellId, symbol, side: 'sell', qty: '1', status: 'filled' }))], '/v2/orders'),
  fills: envelope(brokerFills, '/v2/account/activities/FILL'), positions: envelope([], '/v2/positions') });
const autopsyLinks = executionLinks(autopsyLocal, actualBroker, autopsyTrace);
const selectedLink = autopsyLinks.find((row) => row.tradeId === actualTrades[0].tradeId && row.ledgerEvent === 'EXIT');
assert.equal(selectedLink.realizedPnlUsd, 25, 'USD P&L uses production lifecycle fill events, exact broker fills, and contract size');
assert.equal(selectedLink.tradeSetId, submittedEntry.clientOrderId);
assert.ok(selectedLink.candidates.some((row) => row.fields?.eligible === true));
assert.ok(selectedLink.entryEvidence.some((row) => row.event === 'entry_construction'));
assert.ok(selectedLink.quotesAndThresholds.some((row) => row.event === 'lot_decision' && Number.isFinite(row.fields?.lossThreshold)));
assert.equal(selectedLink.telemetry.some((row) => row.event === 'POST_EXIT_QUOTE'), true, 'actual worker output joins the actual lifecycle execution autopsy');
assert.equal(selectedLink.postExitStatus, 'complete', 'post-exit samples attach through actual trade and execution IDs');
assert.equal(selectedLink.postExitEvidence[0].events.find((row) => row.event === 'POST_EXIT_END').fields.favorableExcursionVsExitFill, 0.15);
await writeFile(new URL('../telemetry/evidence/lane4-simulated-autopsy.json', import.meta.url), `${JSON.stringify({ provenance: 'deterministic simulated lifecycle fixture; production signal, entry, positions, trace writer and post-exit processor; in-memory broker only; no live or PAPER broker request', sourceTrace: autopsySourceTrace, postExitRows: emittedPostExitRows, brokerFills, ledger: actualLedgerEvents, result: autopsyLinks }, null, 2)}\n`);
await rm(autopsyTraceDirectory, { recursive: true, force: true });
const wrongSide = baseBroker();
wrongSide.fills.data[0].side = 'sell';
assert.equal(executionLinks(baseLocal(), wrongSide)[0].match, 'unknown_in_bounded_broker_history');

assert.ok([...runtimeTools].every((item) => !['bot_start', 'bot_stop', 'bot_restart'].includes(item.name)), 'PAPER runtime evidence must not expose lifecycle controls');
process.stdout.write('integration check passed: mode-free PAPER catalog, deterministic reconciliation fixture, UNKNOWN_OUTCOME resolution, exact execution lineage, replacement lineage, shorts, and evidence incompleteness\n');
