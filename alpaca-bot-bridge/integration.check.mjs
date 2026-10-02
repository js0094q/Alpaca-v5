import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBrokerReconciler, executionLinks, tools as reconcileTools } from './reconcile.mjs';
import { tools as brokerTools } from './broker.mjs';
import { tools as runtimeTools } from './runtime.mjs';
import { PAPER_ACCOUNT_ID } from './config.mjs';

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
const wrongSide = baseBroker();
wrongSide.fills.data[0].side = 'sell';
assert.equal(executionLinks(baseLocal(), wrongSide)[0].match, 'unknown_in_bounded_broker_history');

assert.ok([...runtimeTools].every((item) => !['bot_start', 'bot_stop', 'bot_restart'].includes(item.name)), 'PAPER runtime evidence must not expose lifecycle controls');
process.stdout.write('integration check passed: mode-free PAPER catalog, deterministic reconciliation fixture, UNKNOWN_OUTCOME resolution, exact execution lineage, replacement lineage, shorts, and evidence incompleteness\n');
