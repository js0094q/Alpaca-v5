import assert from 'node:assert/strict';
import { createEntry } from './entry.mjs';
import { createPositions } from './positions.mjs';
import { createLedger } from './ledger.mjs';
import { createRuntime } from './runtime.mjs';
import { seedOpeningRange, triggerBreakout } from './check-support.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));
let wall = Date.parse('2026-10-02T14:00:00.000Z');
let mono = 1_000;
let quoteAsk = 0.52;
const fills = [];
const exits = [];
const sellOrders = [];
let buyReplacements = 0;
const entry = createEntry({
  broker: {
    async submitOrder(order) { return { id: 'buy-order-1', status: 'new', ...order }; },
    async replaceOrder() { buyReplacements += 1; return { id: 'buy-order-2', status: 'new' }; },
  },
  getContracts: async () => [{ symbol: 'SPY261002C00660000', strike: 660, contractSize: 100 }],
  getQuote: async () => ({ bid: quoteAsk - 0.02, ask: quoteAsk, timestamp: new Date(wall).toISOString() }),
  onFill: (fill) => fills.push(fill),
  onState: () => {},
  now: () => wall,
  nowMono: () => mono,
  quantity: 3,
});
await entry.onBreakout({ direction: 'CALL', spyPrice: 660, timestamp: wall });
const clientOrderId = entry.getState().clientOrderId;
entry.onOrderUpdate({
  clientOrderId, orderId: 'buy-order-1', event: 'partial_fill', executionId: 'buy-exec-1',
  fillQty: 1, fillPrice: 0.53, timestamp: new Date(wall + 100).toISOString(),
});
entry.onOrderUpdate({
  clientOrderId, orderId: 'buy-order-1', event: 'partial_fill', executionId: 'buy-exec-2',
  fillQty: 1, fillPrice: 0.54, timestamp: new Date(wall + 200).toISOString(),
});
assert.equal(fills.length, 2, 'confirmed partial executions each produce a measurement row');
assert.deepEqual(fills.map(({ entryDecisionAsk, entryPrice, entryFillVsDecisionAsk }) => [entryDecisionAsk, entryPrice, entryFillVsDecisionAsk]), [
  [0.52, 0.53, 0.010000000000000009], [0.52, 0.54, 0.020000000000000018],
]);
quoteAsk = 0.53;
mono += 600;
entry.tick();
await flush();
assert.equal(buyReplacements, 1, 'changed ask causes a confirmed mocked BUY replacement');
entry.onOrderUpdate({
  clientOrderId, orderId: 'buy-order-2', event: 'partial_fill', executionId: 'buy-exec-3',
  fillQty: 1, fillPrice: 0.56, timestamp: new Date(wall + 300).toISOString(),
});
assert.equal(fills.length, 3);
assert.deepEqual(fills.map(({ entryClientOrderId, entryOrderId }) => [entryClientOrderId, entryOrderId]), [
  [clientOrderId, 'buy-order-1'], [clientOrderId, 'buy-order-1'], [clientOrderId, 'buy-order-2'],
]);
assert.equal(fills[0].entryDecisionTimestamp, new Date(wall).toISOString());
assert.equal(fills[0].entryDecisionAt, new Date(wall).toISOString());
assert.deepEqual(fills.map(({ entryDecisionAsk, entryFillVsDecisionAsk }) => [entryDecisionAsk, entryFillVsDecisionAsk]), [
  [0.52, 0.010000000000000009], [0.52, 0.020000000000000018], [0.52, 0.040000000000000036],
], 'entry reference remains the construction ask across a replacement');

const positions = createPositions({
  broker: {
    async submitOrder(order) { sellOrders.push(order); return { id: 'sell-order-1', status: 'new' }; },
    async replaceOrder() { return { id: 'sell-order-2', status: 'new' }; },
    async cancelOrder() {},
  },
  onExit: (exit) => exits.push(exit),
  getDayStartCapital: () => 20,
  onState: () => {},
  now: () => wall,
  nowMono: () => mono,
});
positions.onFill(fills[0]);
wall += 100;
positions.onQuote({ symbol: fills[0].symbol, bid: 0.46, ask: 0.48, timestamp: new Date(wall).toISOString() });
await flush();
assert.equal(sellOrders.length, 1);
positions.onOrderUpdate({
  orderId: 'sell-order-1', event: 'fill', executionId: 'sell-exec-1', fillQty: 1,
  fillPrice: 0.45, timestamp: new Date(wall + 100).toISOString(),
});
assert.equal(exits.length, 1);
assert.deepEqual([exits[0].sellOrderId, exits[0].logicalSellId, exits[0].sellDecisionBid, exits[0].sellFillVsDecisionBid], [
  'sell-order-1', sellOrders[0].clientOrderId, 0.46, -0.010000000000000009,
]);
assert.equal(exits[0].sellDecisionTimestamp, new Date(wall).toISOString());
assert.equal(exits[0].sellDecisionSetAtMs, wall);

// Restored trades without a captured decision reference remain explicitly unknown.
const restoredExits = [];
const restored = createPositions({
  broker: { async submitOrder() { return { id: 'restored-sell', status: 'new' }; }, async replaceOrder() { return { id: 'restored-sell', status: 'new' }; }, async cancelOrder() {} },
  onExit: (exit) => restoredExits.push(exit), onState: () => {}, now: () => wall, nowMono: () => mono,
});
restored.restoreTrade({ tradeId: 'restored-trade', symbol: 'SPY', entryPrice: 1, remainingQty: 1, sellLatched: true, orderId: 'old-sell' });
restored.onQuote({ symbol: 'SPY', bid: 0.9, timestamp: new Date(wall).toISOString() });
await flush();
restored.onOrderUpdate({ orderId: 'restored-sell', event: 'fill', executionId: 'restored-exec', fillQty: 1, fillPrice: 0.89, timestamp: new Date(wall + 1).toISOString() });
assert.equal(restoredExits[0].sellDecisionBid, null);
assert.equal(restoredExits[0].sellFillVsDecisionBid, null);

// Session liquidation pairs with the latest accepted quote and its timestamp.
const liquidatedExits = [];
const liquidation = createPositions({
  broker: { async submitOrder() { return { id: 'liquidation-sell', status: 'new' }; }, async cancelOrder() {} },
  onExit: (exit) => liquidatedExits.push(exit), onState: () => {}, now: () => wall, nowMono: () => mono,
});
liquidation.onFill({ ...fills[0], tradeId: 'liquidation-trade', executionId: 'liquidation-buy', timestamp: new Date(wall).toISOString() });
liquidation.onQuote({ symbol: fills[0].symbol, bid: 0.60, timestamp: new Date(wall + 50).toISOString() });
liquidation.liquidate();
await flush();
liquidation.onOrderUpdate({ orderId: 'liquidation-sell', event: 'fill', executionId: 'liquidation-exec', fillQty: 1, fillPrice: 0.59, timestamp: new Date(wall + 100).toISOString() });
assert.equal(liquidatedExits[0].sellDecisionBid, 0.60);
assert.equal(liquidatedExits[0].sellDecisionTimestamp, new Date(wall + 50).toISOString());

// SELL replacement and partial execution keep the original latched bid reference.
const replacedExits = [];
const replacementOrders = [];
const sellReplacement = createPositions({
  broker: {
    async submitOrder(order) { replacementOrders.push(['submit', order]); return { id: 'sell-parent', status: 'new' }; },
    async replaceOrder(id, order) { replacementOrders.push(['replace', id, order]); return { id: 'sell-child', status: 'new' }; },
    async cancelOrder() {},
  },
  onExit: (exit) => replacedExits.push(exit), onState: () => {}, now: () => wall, nowMono: () => mono,
  getDayStartCapital: () => 4,
});
sellReplacement.onFill({ ...fills[0], tradeId: 'sell-replacement-trade', executionId: 'sell-replacement-buy', timestamp: new Date(wall).toISOString() });
wall += 10_100;
sellReplacement.onQuote({ symbol: fills[0].symbol, bid: 0.46, timestamp: new Date(wall).toISOString() });
await flush();
sellReplacement.onQuote({ symbol: fills[0].symbol, bid: 0.44, timestamp: new Date(wall + 50).toISOString() });
await flush();
assert.deepEqual(replacementOrders.map(([kind]) => kind), ['submit', 'replace']);
sellReplacement.onOrderUpdate({ orderId: 'sell-child', replaces: 'sell-parent', event: 'partial_fill', executionId: 'sell-partial', fillQty: 0.5, fillPrice: 0.43, timestamp: new Date(wall + 100).toISOString() });
assert.deepEqual([replacedExits[0].sellOrderId, replacedExits[0].sellDecisionBid], ['sell-child', 0.46]);
assert.ok(Math.abs(replacedExits[0].sellFillVsDecisionBid + 0.03) < 1e-12);
assert.equal(replacedExits[0].sellDecisionTimestamp, new Date(wall).toISOString());

// Ledger write failures do not block the execution callback path.
const ledger = createLedger({ write: () => Promise.reject(new Error('disk unavailable')) });
assert.doesNotThrow(() => ledger.record({ event: 'FILL', date: '2026-10-02', entryFillVsDecisionAsk: 0.01 }));
await flush();

// A rejecting runtime ledger cannot prevent actual BUY and SELL fill callbacks.
let runtimeWall = Date.parse('2026-10-02T13:30:00.000Z');
let runtimeMono = 0;
const runtimeBrokerOrders = new Map();
let nextRuntimeOrder = 0;
const runtimeLedgerEvents = [];
const runtime = createRuntime({
  broker: {
    async inspectCurrentState() { return { positions: [], orders: [] }; },
    async submitOrder(order) {
      const id = `runtime-order-${++nextRuntimeOrder}`;
      runtimeBrokerOrders.set(id, { ...order, id, status: 'new' });
      return { id, status: 'new' };
    },
    async replaceOrder(id, order) {
      const nextId = `runtime-order-${++nextRuntimeOrder}`;
      runtimeBrokerOrders.set(nextId, { ...runtimeBrokerOrders.get(id), ...order, id: nextId, status: 'new' });
      return { id: nextId, status: 'new' };
    },
    async cancelOrder() {},
  },
  calendar: { sessionFor: () => ({ date: '2026-10-02', status: 'open', open: '2026-10-02T13:30:00Z', close: '2026-10-02T20:00:00Z' }) },
  getContracts: async () => [{ symbol: 'SPY261002C00660000', strike: 660, contractSize: 100 }],
  getQuote: async () => ({ bid: 0.01, ask: 0.04, timestamp: new Date(runtimeWall).toISOString() }),
  now: () => runtimeWall,
  nowMono: () => runtimeMono,
  continuity: { load: () => ({ status: 'missing', trades: [] }), save: () => {} },
  ledger: (event) => { runtimeLedgerEvents.push(event); return Promise.reject(new Error('runtime ledger unavailable')); },
  entryQuantity: 1,
  strategyCapital: 10,
});
try {
  await runtime.startup();
  seedOpeningRange(runtime, '2026-10-02');
  runtimeWall = Date.parse('2026-10-02T13:45:00.000Z');
  triggerBreakout(runtime, '2026-10-02', 102, 'runtime-breakout');
  await flush(); await flush();
  const buy = [...runtimeBrokerOrders.values()].find((order) => order.side === 'buy');
  assert.ok(buy, 'BUY submits while ledger writes reject');
  runtime.onOrderUpdate({ side: 'buy', event: 'fill', orderId: buy.id, clientOrderId: buy.clientOrderId,
    executionId: 'runtime-buy-fill', fillQty: 1, fillPrice: 0.04, timestamp: new Date(runtimeWall).toISOString() });
  runtimeWall += 100;
  runtime.onQuote({ symbol: 'SPY261002C00660000', bid: 0.01, ask: 0.04, timestamp: new Date(runtimeWall).toISOString() });
  await flush();
  const sell = [...runtimeBrokerOrders.values()].find((order) => order.side === 'sell');
  assert.ok(sell, 'SELL submits after the confirmed BUY despite rejected ledger writes');
  runtime.onOrderUpdate({ side: 'sell', event: 'fill', orderId: sell.id, clientOrderId: sell.clientOrderId,
    executionId: 'runtime-sell-fill', fillQty: 1, fillPrice: 0.03, timestamp: new Date(runtimeWall + 100).toISOString() });
  await flush();
  assert.ok(runtimeLedgerEvents.some((event) => event.event === 'FILL' && event.entryFillVsDecisionAsk !== undefined));
  assert.ok(runtimeLedgerEvents.some((event) => event.event === 'EXIT' && event.sellFillVsDecisionBid !== undefined));
  assert.equal(runtime.hasOwnership(), false, 'SELL fill callback closes the position despite rejected ledger writes');
} finally { runtime.stop(); }

console.log('Fill measurement checks passed.');
