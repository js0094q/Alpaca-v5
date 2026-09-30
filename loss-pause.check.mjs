import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContinuity } from './continuity.mjs';
import { createRuntime } from './runtime.mjs';

const symbol = 'SPY260923C00660000';
const date = '2026-09-23';
const session = (day = date) => ({ date: day, status: 'open', open: `${day}T13:30:00Z`, close: `${day}T20:00:00Z` });
const stateFile = () => join(mkdtempSync(join(tmpdir(), 'v5-loss-pause-')), 'state.json');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function brokerWith(snapshot = { positions: [], orders: [] }) {
  const orders = new Map(snapshot.orders.map((order) => [order.id, { ...order }]));
  let nextId = 1;
  return {
    orders,
    inspectCurrentState: async () => ({ positions: snapshot.positions.map((position) => ({ ...position })), orders: [...orders.values()].map((order) => ({ ...order })) }),
    submitOrder: async (order) => { const id = `o${nextId++}`; orders.set(id, { ...order, id, status: 'accepted' }); return { id, status: 'accepted' }; },
    replaceOrder: async (id, order) => { const next = `o${nextId++}`; orders.set(next, { ...orders.get(id), ...order, id: next, status: 'accepted' }); return { id: next, status: 'accepted' }; },
    cancelOrder: async (id) => { const order = orders.get(id); if (order) order.status = 'pending_cancel'; },
  };
}

const makeRuntime = ({ broker, continuity, getQuote = async () => ({ symbol, bid: 1, ask: 1.01, timestamp: new Date(wall).toISOString() }), getCalendar = () => session() }) => createRuntime({
  broker, continuity, now: () => wall, nowMono: () => mono, calendar: { sessionFor: getCalendar },
  getContracts: async () => [{ symbol, strike: 660 }], getQuote,
});

let wall = Date.parse('2026-09-23T14:00:00Z');
let mono = 0;

// Loss is computed from all confirmed fills; an unfilled BUY remainder is excluded,
// but the loss cooldown is not finalized until that BUY reaches a terminal state.
const c = createContinuity({ path: stateFile() });
const b = brokerWith();
const r = makeRuntime({ broker: b, continuity: c });
try {
  await r.startup();
  wall += 31_000; mono += 31_000;
  r.onTrade({ timestamp: new Date(wall).toISOString(), price: 100, tradeId: 'range-1' });
  wall += 1_000; mono += 1_000;
  r.onTrade({ timestamp: new Date(wall).toISOString(), price: 101, tradeId: 'break-1' });
  await flush(); await flush();
  const buy = [...b.orders.values()].find((order) => order.side === 'buy');
  assert.ok(buy, 'breakout submitted a BUY');
  for (const [i, event] of ['partial_fill', 'partial_fill'].entries()) {
    wall += 100; mono += 100;
    r.onOrderUpdate({ event, side: 'buy', orderId: buy.id, clientOrderId: buy.clientOrderId, executionId: `buy-${i}`, fillQty: 1, fillPrice: 1, timestamp: new Date(wall).toISOString() });
  }
  wall += 100; mono += 100;
  r.onOrderUpdate({ event: 'canceled', side: 'buy', orderId: buy.id, clientOrderId: buy.clientOrderId });
  assert.equal(c.load().sets[0].entryQty, 2, 'unfilled third contract is absent from the buy-set result');
  wall += 10_001; mono += 10_001;
  r.onQuote({ symbol, bid: 1, ask: 1.01, timestamp: new Date(wall).toISOString() });
  wall += 100; mono += 100;
  r.onQuote({ symbol, bid: 0.89, ask: 0.90, timestamp: new Date(wall).toISOString() });
  const sells = [...b.orders.values()].filter((order) => order.side === 'sell');
  assert.equal(sells.length, 2, 'only filled contracts receive SELL orders');
  const soldAt = wall + 100;
  for (const [index, sell] of sells.entries()) {
    wall = soldAt; mono += 100;
    r.onOrderUpdate({ event: 'fill', side: 'sell', orderId: sell.id, clientOrderId: sell.clientOrderId, executionId: `sell-${sell.id}`, fillQty: 1, fillPrice: 0.80, timestamp: new Date(wall).toISOString() });
    if (index === 0) assert.deepEqual([c.load().sets[0].exitQty, c.load().sets[0].exitCentQty], [1, 80], 'partial confirmed exit is persisted immediately');
  }
  assert.equal(r.getState().lossPauseUntil, soldAt + 60_000, 'strictly negative confirmed gross premium starts a 60s pause');
  assert.equal(r.getState().cooldownUntil, mono + 60_000, 'runtime gate uses the remaining wall-clock pause');
  assert.equal(c.load().pause.until, soldAt + 60_000, 'pause persists when no active trade remains');
  const sip = { symbol: 'SPY', price: 100, timestamp: new Date(wall).toISOString(), conditions: [' '], tradeId: 9, exchange: 'K', tape: 'A', rawType: 't' };
  assert.equal(r.onRawTrade(sip).accepted, true, 'SIP observation continues during the pause');
} finally { r.stop(); }

// A restored same-day pause remains a gate after restart; a new session date clears it.
wall += 1_000; mono = 0;
const restartedBroker = brokerWith();
const restarted = makeRuntime({ broker: restartedBroker, continuity: c });
try {
  await restarted.startup();
  assert.equal(restarted.getState().state, 'COOLDOWN');
  assert.equal(restarted.getState().lossPauseUntil, c.load().pause.until);
  assert.equal(restarted.getState().cooldownUntil, c.load().pause.until - wall, 'restart restores only the remaining pause duration');
  const restoredBuyCount = [...restartedBroker.orders.values()].filter((order) => order.side === 'buy').length;
  const pauseUntil = c.load().pause.until;
  const restartWall = wall;
  wall = pauseUntil - 1_000; mono = wall - restartWall;
  restarted.tick();
  restarted.onTrade({ timestamp: new Date(wall).toISOString(), price: 100, tradeId: 'pause-range' });
  wall += 100; mono += 100;
  restarted.onTrade({ timestamp: new Date(wall).toISOString(), price: 101, tradeId: 'pause-breakout' });
  await flush();
  assert.equal([...restartedBroker.orders.values()].filter((order) => order.side === 'buy').length, restoredBuyCount, 'breakout just before expiry is ignored');
  wall = pauseUntil + 1; mono += 1_001; restarted.tick();
  assert.equal(restarted.getState().state, 'FLAT');
  assert.equal([...restartedBroker.orders.values()].filter((order) => order.side === 'buy').length, restoredBuyCount, 'ignored breakout is not queued after expiry');
  wall += 100; mono += 100;
  restarted.onTrade({ timestamp: new Date(wall).toISOString(), price: 102, tradeId: 'after-pause-breakout' });
  await flush(); await flush();
  assert.equal([...restartedBroker.orders.values()].filter((order) => order.side === 'buy').length, restoredBuyCount + 1, 'a fresh post-expiry breakout may submit BUY');
  const nextDate = '2026-09-24';
  const nextDay = makeRuntime({ broker: brokerWith(), continuity: c, getCalendar: () => session(nextDate) });
  try {
    await nextDay.startup();
    assert.equal(nextDay.getState().lossPauseUntil, null, 'pause does not carry into the next session date');
    assert.equal(c.load().pause ?? null, null);
  } finally { nextDay.stop(); }
} finally { restarted.stop(); }

// Partial exit totals persist through a restart. One prior $0.90 exit plus two
// $1.05 exits against three $1.00 entries is exactly zero: normal 5s cooldown.
wall = Date.parse('2026-09-23T15:00:00Z'); mono = 2_000;
const partialPath = stateFile();
const partialContinuity = createContinuity({ path: partialPath });
const activeTrade = {
  tradeId: 'remaining-lot', executionId: 'entry-fill-1', symbol, entryPrice: 1, contractSize: 100,
  contractSizeSource: 'alpaca_contract_metadata', fillTimestampMs: wall - 20_000, anchorBid: null,
  anchorSetAtMs: null, anchorSourceTimestamp: null, remainingQty: 2, profitFloor: null,
  sellLatched: true, logicalSellId: 'v5-sell-set', orderId: 'sell-active', signalId: 'signal-1', tradeSetId: 'v5-buy-set',
};
partialContinuity.save([activeTrade], { pause: null, sets: [{
  tradeSetId: 'v5-buy-set', date, known: true, entryQty: 3, entryCentQty: 300,
  exitQty: 1, exitCentQty: 90, entryTerminal: true, closedAt: null,
}] });
const partialBroker = brokerWith({
  positions: [{ symbol, qty: 2 }],
  orders: [{ id: 'sell-active', symbol, qty: 2, filled_qty: 0, side: 'sell', status: 'accepted', client_order_id: 'v5-sell-set' }],
});
const afterRestart = makeRuntime({ broker: partialBroker, continuity: partialContinuity });
try {
  await afterRestart.startup();
  wall += 1_000;
  afterRestart.onOrderUpdate({ event: 'fill', side: 'sell', orderId: 'sell-active', clientOrderId: 'v5-sell-set', executionId: 'sell-restored', fillQty: 2, fillPrice: 1.05, timestamp: new Date(wall).toISOString() });
  assert.equal(afterRestart.getState().lossPauseUntil, null, 'restart accounting recognizes exact zero rather than a false loss');
  assert.equal(afterRestart.getState().cooldownUntil, mono + 5_000, 'zero result keeps the normal cooldown');
  assert.equal(partialContinuity.load().status, 'missing', 'resolved zero-result set leaves no stale state');
} finally { afterRestart.stop(); }

// Positive gross premium also keeps the normal cooldown.
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
  assert.equal(profitRuntime.getState().lossPauseUntil, null);
  assert.equal(profitRuntime.getState().cooldownUntil, mono + 5_000, 'positive result keeps the normal cooldown');
} finally { profitRuntime.stop(); }

console.log('loss-pause.check ok');
