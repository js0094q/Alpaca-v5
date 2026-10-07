import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContinuity } from './continuity.mjs';
import { createRuntime } from './runtime.mjs';
import { seedOpeningRange, triggerBreakout } from './check-support.mjs';

const symbol = 'SPY260923C00660000';
const date = '2026-09-23';
const session = (day = date) => ({ date: day, status: 'open', open: `${day}T13:30:00Z`, close: `${day}T20:00:00Z` });
const stateFile = () => join(mkdtempSync(join(tmpdir(), 'v5-entry-day-')), 'state.json');
const flush = () => new Promise((resolve) => setImmediate(resolve));
let wall = Date.parse(`${date}T13:29:59Z`);
let mono = 0;

function brokerWith(snapshot = { positions: [], orders: [] }) {
  const orders = new Map(snapshot.orders.map((order) => [order.id, { ...order }]));
  let nextId = 1;
  return {
    orders,
    async inspectCurrentState() { return { account: { equity: 460.45 }, positions: snapshot.positions.map((position) => ({ ...position })), orders: [...orders.values()].map((order) => ({ ...order })) }; },
    async submitOrder(order) { const id = `o${nextId++}`; orders.set(id, { ...order, id, status: 'accepted' }); return { id, status: 'accepted' }; },
    async replaceOrder(id, order) { const next = `o${nextId++}`; orders.set(next, { ...orders.get(id), ...order, id: next, status: 'accepted' }); return { id: next, status: 'accepted' }; },
    async cancelOrder(id) { const order = orders.get(id); if (order) order.status = 'pending_cancel'; },
  };
}

function makeRuntime({ broker, continuity, getCalendar = () => session(), liquidateAt = null }) {
  return createRuntime({ broker, continuity, now: () => wall, nowMono: () => mono, calendar: { sessionFor: getCalendar },
    getContracts: async () => [{ symbol, strike: 660 }], getQuote: async () => ({ symbol, bid: 1, ask: 1.01, timestamp: new Date(wall).toISOString() }),
    dailyLossGuard: true, strategyCapital: 460.45, entryQuantity: 1, liquidateAt });
}

// Legacy persisted pause state is ignored; only the five-second exit cooldown
// and the separate filled-entry marker govern current sessions.
{
  const oldPause = createContinuity({ path: stateFile() });
  oldPause.save([], { pause: { date, until: Date.parse(`${date}T13:31:00Z`) }, sets: [], filledEntryDate: null,
    dailyLoss: { date, dayStartEquity: 460.45, cumulativeRealizedGross: 0, peakRealizedGross: 0, tripped: false, completedBuyIds: [] } });
  const legacyBroker = brokerWith();
  const legacyRuntime = makeRuntime({ broker: legacyBroker, continuity: oldPause });
  try {
    await legacyRuntime.startup();
    assert.equal(legacyRuntime.getState().cooldownUntil, 0);
    wall = Date.parse(`${date}T13:30:00Z`); seedOpeningRange(legacyRuntime, date);
    wall = Date.parse(`${date}T13:45:00Z`); triggerBreakout(legacyRuntime, date, 102, 'legacy-pause-breakout');
    await flush();
    assert.equal([...legacyBroker.orders.values()].filter((order) => order.side === 'buy').length, 1, 'legacy pause does not block a covered entry');
  } finally { legacyRuntime.stop(); }
}

// A confirmed losing exit uses only the ordinary five-second cooldown. A
// filled entry consumes the session's single entry even after the position closes.
wall = Date.parse(`${date}T13:29:59Z`); mono = 0;
const continuity = createContinuity({ path: stateFile() });
const broker = brokerWith();
const liquidationTime = Date.parse(`${date}T13:46:00Z`);
const runtime = makeRuntime({ broker, continuity, liquidateAt: liquidationTime });
try {
  await runtime.startup();
  wall = Date.parse(`${date}T13:30:00Z`);
  seedOpeningRange(runtime, date);
  wall = Date.parse(`${date}T13:45:00Z`);
  triggerBreakout(runtime, date, 102, 'first-breakout');
  await flush(); await flush();
  const buy = [...broker.orders.values()].find((order) => order.side === 'buy');
  assert.ok(buy, 'covered opening-range breakout submits a BUY');
  runtime.onOrderUpdate({ event: 'fill', side: 'buy', orderId: buy.id, clientOrderId: buy.clientOrderId,
    executionId: 'first-buy-fill', fillQty: 1, fillPrice: 1, timestamp: new Date(wall + 1).toISOString() });
  runtime.onQuote({ symbol, bid: 1, ask: 1.01, timestamp: new Date(wall + 2).toISOString() });
  wall = liquidationTime; mono += 1_000; runtime.tick();
  await flush(); await flush();
  const sell = [...broker.orders.values()].find((order) => order.side === 'sell');
  assert.ok(sell, 'scheduled liquidation keeps the persistent SELL path');
  runtime.onOrderUpdate({ event: 'fill', side: 'sell', orderId: sell.id, clientOrderId: sell.clientOrderId,
    executionId: 'first-sell-fill', fillQty: 1, fillPrice: 0.80, timestamp: new Date(wall + 1).toISOString() });
  broker.orders.get(buy.id).status = 'filled';
  broker.orders.get(sell.id).status = 'filled';
  assert.equal(runtime.getState().dailyLoss.cumulativeRealizedGross, -20);
  assert.equal(runtime.getState().lossPauseUntil, undefined, 'there is no 60-second loss pause');
  assert.equal(runtime.getState().cooldownUntil, mono + 5_000, 'exit still uses the ordinary five-second cooldown');
  assert.equal(runtime.getState().filledEntryDate, date);
  assert.deepEqual(runtime.getState().dailyLoss.completedBuyIds, [buy.clientOrderId]);

  wall += 6_000; mono += 6_000; runtime.tick();
  const before = [...broker.orders.values()].filter((order) => order.side === 'buy').length;
  triggerBreakout(runtime, date, 103, 'second-breakout');
  await flush();
  assert.equal([...broker.orders.values()].filter((order) => order.side === 'buy').length, before, 'cooldown expiry cannot permit a second filled entry that day');
} finally { runtime.stop(); }

// A same-day restart preserves the consumed-entry marker.
wall = Date.parse(`${date}T13:29:59Z`); mono = 0;
const restartedBroker = brokerWith();
const restarted = makeRuntime({ broker: restartedBroker, continuity });
try {
  await restarted.startup();
  wall = Date.parse(`${date}T13:30:00Z`); seedOpeningRange(restarted, date);
  wall = Date.parse(`${date}T13:45:00Z`); triggerBreakout(restarted, date, 102, 'restart-breakout');
  await flush();
  assert.equal([...restartedBroker.orders.values()].filter((order) => order.side === 'buy').length, 0, 'restart cannot create another filled entry that day');
  assert.equal(restarted.getState().filledEntryDate, date);
} finally { restarted.stop(); }

// Partial exit totals persist through restart and zero/profit outcomes use only
// the ordinary five-second cooldown.
wall = Date.parse('2026-09-23T15:00:00Z'); mono = 2_000;
const activeTrade = {
  tradeId: 'remaining-lot', executionId: 'entry-fill-1', symbol, entryPrice: 1, contractSize: 100,
  contractSizeSource: 'alpaca_contract_metadata', fillTimestampMs: wall - 20_000, anchorBid: null,
  anchorSetAtMs: null, anchorSourceTimestamp: null, remainingQty: 2, profitFloor: null,
  sellLatched: true, logicalSellId: 'v5-sell-set', orderId: 'sell-active', signalId: 'signal-1', tradeSetId: 'v5-buy-set',
};
const partialContinuity = createContinuity({ path: stateFile() });
partialContinuity.save([activeTrade], { pause: null, sets: [{
  tradeSetId: 'v5-buy-set', date, known: true, entryQty: 3, entryCentQty: 300,
  exitQty: 1, exitCentQty: 90, entryTerminal: true, closedAt: null,
}] });
const partialBroker = brokerWith({ positions: [{ symbol, qty: 2 }], orders: [{ id: 'sell-active', symbol, qty: 2, filled_qty: 0, side: 'sell', status: 'accepted', client_order_id: 'v5-sell-set' }] });
const afterRestart = makeRuntime({ broker: partialBroker, continuity: partialContinuity });
try {
  await afterRestart.startup();
  wall += 1_000;
  afterRestart.onOrderUpdate({ event: 'fill', side: 'sell', orderId: 'sell-active', clientOrderId: 'v5-sell-set', executionId: 'sell-restored', fillQty: 2, fillPrice: 1.05, timestamp: new Date(wall).toISOString() });
  assert.equal(afterRestart.getState().cooldownUntil, mono + 5_000, 'zero result keeps the normal cooldown');
  assert.equal(partialContinuity.load().status, 'compatible');
  assert.equal(partialContinuity.load().sets.length, 0, 'resolved zero-result set leaves no stale set accounting');
} finally { afterRestart.stop(); }

wall = Date.parse('2026-09-23T15:10:00Z'); mono = 7_000;
const profitContinuity = createContinuity({ path: stateFile() });
profitContinuity.save([activeTrade], { pause: null, sets: [{
  tradeSetId: 'v5-buy-set', date, known: true, entryQty: 3, entryCentQty: 300,
  exitQty: 1, exitCentQty: 90, entryTerminal: true, closedAt: null,
}] });
const profitRuntime = makeRuntime({ broker: brokerWith({
  positions: [{ symbol, qty: 2 }],
  orders: [{ id: 'sell-active', symbol, qty: 2, filled_qty: 0, side: 'sell', status: 'accepted', client_order_id: 'v5-sell-set' }],
}), continuity: profitContinuity });
try {
  await profitRuntime.startup();
  wall += 1_000;
  profitRuntime.onOrderUpdate({ event: 'fill', side: 'sell', orderId: 'sell-active', clientOrderId: 'v5-sell-set', executionId: 'sell-profit', fillQty: 2, fillPrice: 1.06, timestamp: new Date(wall).toISOString() });
  assert.equal(profitRuntime.getState().cooldownUntil, mono + 5_000, 'positive result keeps the normal cooldown');
} finally { profitRuntime.stop(); }

console.log('entry-per-day checks passed');
