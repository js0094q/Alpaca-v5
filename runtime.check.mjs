import assert from 'node:assert/strict';
import { createRuntime } from './runtime.mjs';
import { handleProviderStatus } from './paper.mjs';
import { createContinuity } from './continuity.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const symbol = 'SPY260923C00660000';
const calendar = { sessionFor: () => ({ date: '2026-09-23', status: 'open', open: '2026-09-23T13:30:00Z', close: '2026-09-23T20:00:00Z' }) };
const makeBroker = (initial = []) => {
  const orders = new Map(initial.map((order) => [order.id, { ...order }]));
  let nextId = initial.length + 1;
  return {
    orders,
    inspectCurrentState: async () => ({ positions: [], orders: [...orders.values()] }),
    submitOrder: async (order) => { const id = `o${nextId++}`; orders.set(id, { ...order, id, status: 'new' }); return { id, status: 'new', clientOrderId: order.clientOrderId }; },
    replaceOrder: async (id, order) => { const next = `o${nextId++}`; orders.set(next, { ...orders.get(id), ...order, id: next, status: 'new' }); return { id: next, status: 'new' }; },
    cancelOrder: async (id) => { const order = orders.get(id); if (order) order.status = 'pending_cancel'; },
  };
};
const options = { getContracts: async () => [{ symbol, strike: 660 }], getQuote: async () => ({ symbol, bid: 1.04, ask: 1.05, timestamp: new Date().toISOString() }) };
let wall = Date.parse('2026-09-23T15:29:28-04:00');
let mono = 0;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const continuity = () => createContinuity({ path: join(mkdtempSync(join(tmpdir(), 'v5-runtime-')), 'state.json') });

const interruptedOrder = { id: 'interrupted', symbol, qty: 3, side: 'buy', status: 'accepted', clientOrderId: 'v5-buy-interrupted' };
const startupBroker = makeBroker([interruptedOrder]);
const startupRuntime = createRuntime({ broker: startupBroker, calendar, now: () => wall, nowMono: () => mono, continuity: continuity(), ...options });
try {
  await startupRuntime.startup();
  assert.notEqual(startupRuntime.getState().state, 'FLAT');
  startupRuntime.onOrderUpdate({ event: 'canceled', side: 'buy', orderId: 'interrupted', clientOrderId: 'v5-buy-interrupted' });
  assert.equal(startupRuntime.getState().state, 'FLAT');
} finally { startupRuntime.stop(); }

const broker = makeBroker();
const runtime = createRuntime({ broker, calendar, now: () => wall, nowMono: () => mono, continuity: continuity(), ...options });
try {
  await runtime.startup();
  const sourceTimestamp = new Date(wall).toISOString().replace('.000Z', '.000000123Z');
  const raw = { symbol: 'SPY', price: 659, timestamp: sourceTimestamp, conditions: [' '], tradeId: 1, exchange: 'K', tape: 'A', rawType: 't' };
  assert.equal(runtime.onRawTrade(raw).accepted, true);
  assert.equal(runtime.onRawTrade(raw).accepted, false, 'duplicate SIP print is not accepted twice');
  for (let i = 0; i < 30; i += 1) { wall += 1_000; runtime.onTrade({ timestamp: new Date(wall).toISOString(), price: 659 }); }
  wall += 1_000; runtime.onTrade({ timestamp: new Date(wall).toISOString(), price: 660 });
  await flush(); await flush();
  const buys = [...broker.orders.values()].filter((o) => o.side === 'buy' && o.clientOrderId?.startsWith('v5-buy-'));
  assert.equal(buys.length, 1); assert.equal(buys[0].qty, 3);
  const buy = buys[0];
  runtime.onOrderUpdate({ event: 'partial_fill', side: 'buy', orderId: buy.id, clientOrderId: buy.clientOrderId, executionId: 'buy-e1', fillQty: 1, fillPrice: 1, timestamp: new Date(wall).toISOString() });
  runtime.onOrderUpdate({ event: 'partial_fill', side: 'buy', orderId: buy.id, clientOrderId: buy.clientOrderId, executionId: 'buy-e2', fillQty: 1, fillPrice: 1, timestamp: new Date(wall).toISOString() });
  runtime.onOrderUpdate({ event: 'fill', side: 'buy', orderId: buy.id, clientOrderId: buy.clientOrderId, executionId: 'buy-e3', fillQty: 1, fillPrice: 1, timestamp: new Date(wall).toISOString() });
  assert.equal(wall, Date.parse('2026-09-23T15:29:59-04:00'), 'position owned before cutoff');
  wall = Date.parse('2026-09-23T15:30:00-04:00');
  runtime.tick();
  assert.equal(runtime.getState().state, 'MANAGING');
  assert.equal([...broker.orders.values()].filter((o) => o.side === 'sell').length, 0, 'cutoff does not force an exit');
  const initialWarmup = runtime.getState().warmupUntil;
  const providerStatus = (stream, status) => handleProviderStatus(runtime, { stream, status });
  for (const stream of ['wss://stream.data.alpaca.markets/v1beta1/opra', 'wss://paper-api.alpaca.markets/stream']) {
    providerStatus(stream, 'disconnected'); providerStatus(stream, 'reconnected');
  }
  assert.equal(runtime.getState().warmupUntil, initialWarmup);
  providerStatus('wss://stream.data.alpaca.markets/v2/sip', 'disconnected');
  assert.equal(runtime.getState().warmupUntil, wall + 30_000);
  wall = Date.parse('2026-09-23T15:30:09-04:00');
  runtime.onQuote({ symbol, bid: 1, ask: 1.01, timestamp: new Date(wall).toISOString() });
  wall += 1_000;
  runtime.onQuote({ symbol, bid: 1.05, ask: 1.06, timestamp: new Date(wall).toISOString() });
  wall += 1_000;
  runtime.onQuote({ symbol, bid: 1.00, ask: 1.01, timestamp: new Date(wall + 1_000).toISOString() }); // below the +2/−4 trail floor
  await flush(); await flush();
  const sells = [...broker.orders.values()].filter((o) => o.side === 'sell');
  assert.equal(sells.length, 3, 'owned SELL management remains allowed at broker BUY cutoff'); assert.ok(sells.every((o) => o.qty === 1));
  providerStatus('wss://stream.data.alpaca.markets/v2/sip', 'reconnected');
  assert.equal(runtime.getState().warmupUntil, wall + 30_000);
  assert.equal(runtime.getState().state, 'MANAGING', 'ownership remains until broker SELL fills');
  for (const sell of sells) runtime.onOrderUpdate({ event: 'fill', side: 'sell', orderId: sell.id, clientOrderId: sell.clientOrderId, executionId: `sell-${sell.id}`, fillQty: 1, fillPrice: 1.00, timestamp: new Date(wall + 2_000).toISOString() });
  assert.equal(runtime.getState().state, 'COOLDOWN');
  mono = 4_999; runtime.tick(); assert.equal(runtime.getState().state, 'COOLDOWN');
  mono = 5_000; runtime.tick(); assert.equal(runtime.getState().state, 'FLAT');
  wall += 2_000; runtime.onTrade({ timestamp: new Date(wall).toISOString(), price: 659 });
  wall += 1_000; runtime.onTrade({ timestamp: new Date(wall).toISOString(), price: 661 });
  await flush(); await flush();
  assert.equal([...broker.orders.values()].filter((o) => o.side === 'buy').length, 1, 'no re-entry after cutoff and broker-confirmed flat');
} finally { runtime.stop(); }

// Keep receipt time before cutoff to exercise the runtime source-time gate independently.
const cutoffBroker = makeBroker();
wall = Date.parse('2026-09-23T15:29:28-04:00');
const cutoffRuntime = createRuntime({ broker: cutoffBroker, calendar, now: () => wall, nowMono: () => mono, continuity: continuity(), ...options });
try {
  await cutoffRuntime.startup();
  wall = Date.parse('2026-09-23T15:29:59.999-04:00');
  for (const time of ['15:30:00.000', '15:31:00.000']) {
    const source = Date.parse(`2026-09-23T${time}-04:00`);
    cutoffRuntime.onTrade({ timestamp: new Date(source - 1).toISOString(), price: 659 });
    assert.equal(cutoffRuntime.onTrade({ timestamp: new Date(source).toISOString(), price: 660 }).reason, 'entry-cutoff');
    await flush();
    assert.equal(cutoffRuntime.getState().state, 'FLAT');
    assert.equal(cutoffBroker.orders.size, 0, `${time} source time is rejected by runtime entry gate`);
  }
} finally { cutoffRuntime.stop(); }

// A restored same-day loss pause may extend beyond 15:30, but the pause cannot
// widen the session entry window or permit a BUY at the broker cutoff.
{
  const cutoff = Date.parse('2026-09-23T15:30:00-04:00');
  let pauseWall = cutoff - 60_000, pauseMono = 0;
  const saved = continuity();
  saved.save([], { pause: { date: '2026-09-23', until: cutoff + 60_000 }, sets: [] });
  const pauseBroker = makeBroker();
  const pauseRuntime = createRuntime({ broker: pauseBroker, calendar, now: () => pauseWall, nowMono: () => pauseMono, continuity: saved, ...options });
  try {
    await pauseRuntime.startup();
    assert.equal(pauseRuntime.getState().lossPauseUntil, cutoff + 60_000);
    for (let i = 0; i < 30; i += 1) pauseRuntime.onTrade({ timestamp: new Date(cutoff - 30_000 + i * 1_000).toISOString(), price: 659 });
    pauseWall = cutoff; pauseMono = 60_000;
    pauseRuntime.onTrade({ timestamp: new Date(cutoff).toISOString(), price: 660 });
    assert.equal([...pauseBroker.orders.values()].filter((order) => order.side === 'buy').length, 0);
  } finally { pauseRuntime.stop(); }
}

// A missed SELL fill or external close must release stale local ownership only after complete broker-flat evidence.
const makeRecovery = async ({ trade = {}, extraTrades = [], startupPositions = [{ symbol, qty: 1 }], startupOrders = [], submitOrder } = {}) => {
  let snapshot = { positions: startupPositions, orders: startupOrders };
  let recoveryMono = 0;
  let inspections = 0;
  let mutations = 0;
  const events = [];
  const saved = continuity();
  saved.save([{ tradeId: 'stale-lot', executionId: 'buy-stale', symbol, entryPrice: 1,
    fillTimestampMs: Date.parse('2026-09-23T13:59:40Z'), anchorBid: 1, anchorTimestampMs: Date.parse('2026-09-23T13:59:50Z'),
    remainingQty: 1, profitFloor: null, sellLatched: false, logicalSellId: null, orderId: null, ...trade }, ...extraTrades]);
  const runtime = createRuntime({
    broker: {
      inspectCurrentState: async () => { inspections++; if (snapshot instanceof Error) throw snapshot; return typeof snapshot === 'function' ? snapshot() : snapshot; },
      submitOrder: async (order) => { mutations++; if (submitOrder) return submitOrder(order); throw new Error('recovery must not submit an order'); },
      replaceOrder: async () => { mutations++; throw new Error('recovery must not replace an order'); },
      cancelOrder: async () => { mutations++; throw new Error('recovery must not cancel an order'); },
    },
    calendar, now: () => Date.parse('2026-09-23T10:00:00-04:00'), nowMono: () => recoveryMono,
    continuity: saved, ledger: (event) => events.push(event), ...options,
  });
  await runtime.startup();
  assert.equal(runtime.getState().state, 'MANAGING');
  const poll = async (at, next = snapshot) => {
    recoveryMono = at; snapshot = next; runtime.tick(); await flush(); await flush();
  };
  return { runtime, saved, events, poll, inspections: () => inspections, mutations: () => mutations };
};

const recovered = await makeRecovery();
try {
  await recovered.poll(5_000, { positions: [], orders: [] });
  assert.equal(recovered.runtime.getState().state, 'COOLDOWN', 'one complete flat read clears local ownership');
  assert.equal(recovered.saved.load().status, 'missing');
  assert.ok(recovered.events.some((event) => event.event === 'ALREADY_CLOSED' && event.tradeId === 'stale-lot' && event.qty === 1));
  assert.equal(recovered.events.some((event) => event.event === 'EXIT'), false, 'no invented SELL fill');
  assert.equal(recovered.mutations(), 0, 'recovery submits no broker action');
  await recovered.poll(9_999); assert.equal(recovered.runtime.getState().state, 'COOLDOWN');
  await recovered.poll(10_000); assert.equal(recovered.runtime.getState().state, 'FLAT');
  assert.equal(recovered.inspections(), 2, 'no extra flatness polling');
} finally { recovered.runtime.stop(); }

const otherSymbol = 'SPY260923P00660000';
const separateHolding = await makeRecovery({
  extraTrades: [{ tradeId: 'other-lot', executionId: 'buy-other', symbol: otherSymbol, entryPrice: 1,
    fillTimestampMs: 1, remainingQty: 1, profitFloor: null, sellLatched: false, logicalSellId: null, orderId: null }],
  startupPositions: [{ symbol, qty: 1 }, { symbol: otherSymbol, qty: 1 }],
});
try {
  await separateHolding.poll(5_000, { positions: [{ symbol: otherSymbol, qty: 1 }], orders: [] });
  assert.equal(separateHolding.runtime.getState().state, 'MANAGING');
  assert.deepEqual(separateHolding.saved.load().trades.map((trade) => trade.tradeId), ['other-lot'], 'other owned option remains');
} finally { separateHolding.runtime.stop(); }

const missedSell = await makeRecovery({
  trade: { sellLatched: true, logicalSellId: 'v5-sell-missed', orderId: 'sell-missed' },
  startupOrders: [{ id: 'sell-missed', symbol, side: 'sell', status: 'accepted', qty: 1, filled_qty: 0, client_order_id: 'v5-sell-missed' }],
});
try {
  await missedSell.poll(5_000, { positions: [], orders: [] });
  assert.equal(missedSell.runtime.getState().state, 'COOLDOWN', 'missed SELL lifecycle fill is recoverable');
  assert.equal(missedSell.events.some((event) => event.event === 'EXIT'), false);
} finally { missedSell.runtime.stop(); }

const unresolvedSell = await makeRecovery({ trade: { sellLatched: true, logicalSellId: 'v5-sell-unknown' } });
try {
  await unresolvedSell.poll(5_000, { positions: [], orders: [] });
  assert.equal(unresolvedSell.runtime.getState().state, 'MANAGING', 'unacknowledged SELL remains unresolved');
} finally { unresolvedSell.runtime.stop(); }

const inFlightSell = await makeRecovery({
  trade: { sellLatched: true, logicalSellId: 'v5-sell-in-flight' },
  submitOrder: async () => new Promise(() => {}),
});
try {
  inFlightSell.runtime.onQuote({ symbol, bid: 1, ask: 1.01, timestamp: '2026-09-23T14:00:00Z' });
  assert.equal(inFlightSell.mutations(), 1, 'normal SELL submission is in flight');
  await inFlightSell.poll(5_000, { positions: [], orders: [] });
  assert.equal(inFlightSell.runtime.getState().state, 'MANAGING', 'in-flight SELL prevents recovery');
  assert.equal(inFlightSell.mutations(), 1, 'recovery submits no further order');
} finally { inFlightSell.runtime.stop(); }

const changedDuringRead = await makeRecovery();
try {
  let resolveRead;
  await changedDuringRead.poll(5_000, () => new Promise((resolve) => { resolveRead = resolve; }));
  changedDuringRead.runtime.tick();
  assert.equal(changedDuringRead.inspections(), 2, 'concurrent ticks share one broker read');
  changedDuringRead.runtime.onQuote({ symbol, bid: 1.05, ask: 1.06, timestamp: '2026-09-23T14:00:00Z' });
  resolveRead({ positions: [], orders: [] });
  await flush(); await flush();
  assert.equal(changedDuringRead.runtime.getState().state, 'MANAGING', 'stale asynchronous read cannot clear changed local ownership');
  assert.equal(changedDuringRead.saved.load().trades[0].profitFloor, 1.01, 'first +5c peak protects peak minus 4c');
} finally { changedDuringRead.runtime.stop(); }

for (const unsafe of [
  { positions: [] },
  { orders: [] },
  { positions: [{ symbol, qty: 1 }], orders: [] },
  { positions: [{ symbol, qty: -1 }], orders: [] },
  { positions: [{ symbol }], orders: [] },
  { positions: [{}], orders: [] },
  { positions: [{ symbol: '' }], orders: [] },
  { positions: [], orders: [{ symbol, side: 'buy', status: 'new', client_order_id: 'v5-buy-open' }] },
  { positions: [], orders: [{ symbol, side: 'sell', status: 'accepted', client_order_id: 'v5-sell-open' }] },
  { positions: [], orders: [{ symbol: 'SPY260923P00660000', side: 'buy', status: 'accepted', client_order_id: 'v5-buy-other' }] },
  { positions: [], orders: [{ symbol: 'SPY260923P00660000', status: 'accepted', client_order_id: 'v5-buy-unknown-side' }] },
  { positions: [], orders: [{ side: 'sell', status: 'accepted' }] },
  { positions: [], orders: [{ symbol: '', side: 'sell', status: 'accepted' }] },
  new Error('broker read failed'),
]) {
  const blocked = await makeRecovery();
  try {
    await blocked.poll(5_000, unsafe);
    assert.equal(blocked.runtime.getState().state, 'MANAGING', 'unsafe broker evidence must retain local ownership');
    assert.equal(blocked.saved.load().trades[0].tradeId, 'stale-lot');
    assert.equal(blocked.events.some((event) => event.event === 'ALREADY_CLOSED'), false);
  } finally { blocked.runtime.stop(); }
}

const incompleteAtStartup = continuity();
incompleteAtStartup.save([{ tradeId: 'persisted-lot', executionId: 'buy-persisted', symbol, entryPrice: 1,
  fillTimestampMs: 1,
  remainingQty: 1, profitFloor: null, sellLatched: false, logicalSellId: null, orderId: null }]);
const invalidStartup = createRuntime({ broker: { inspectCurrentState: async () => ({ positions: [] }) },
  calendar, now: () => Date.parse('2026-09-23T10:00:00-04:00'), continuity: incompleteAtStartup, ...options });
await assert.rejects(invalidStartup.startup(), /Incomplete broker current state/);
assert.equal(incompleteAtStartup.load().trades[0].tradeId, 'persisted-lot', 'incomplete startup read retains continuity');
invalidStartup.stop();

for (const order of [
  { id: 'open-sell', symbol, side: 'sell', status: 'accepted', client_order_id: 'v5-sell-open' },
  { id: 'open-buy', symbol: 'SPY260923P00660000', side: 'buy', status: 'accepted', client_order_id: 'v5-buy-open' },
  { id: 'unknown-symbol', symbol: '', side: 'sell', status: 'accepted' },
]) {
  const saved = continuity();
  saved.save([{ tradeId: 'persisted-lot', executionId: 'buy-persisted', symbol, entryPrice: 1,
    fillTimestampMs: 1,
    remainingQty: 1, profitFloor: null, sellLatched: false, logicalSellId: null, orderId: null }]);
  const runtime = createRuntime({ broker: { inspectCurrentState: async () => ({ positions: [], orders: [order] }), cancelOrder: async () => {} },
    calendar, now: () => Date.parse('2026-09-23T10:00:00-04:00'), continuity: saved, ...options });
  await assert.rejects(runtime.startup(), /Unresolved broker order/);
  assert.equal(saved.load().trades[0].tradeId, 'persisted-lot', 'open broker order retains continuity');
  runtime.stop();
}
const invalidQty = continuity();
invalidQty.save([{ tradeId: 'persisted-lot', executionId: 'buy-persisted', symbol, entryPrice: 1,
  fillTimestampMs: 1,
  remainingQty: 1, profitFloor: null, sellLatched: false, logicalSellId: null, orderId: null }]);
const invalidPosition = createRuntime({ broker: { inspectCurrentState: async () => ({ positions: [{ symbol }], orders: [] }) },
  calendar, now: () => Date.parse('2026-09-23T10:00:00-04:00'), continuity: invalidQty, ...options });
await assert.rejects(invalidPosition.startup(), /Incomplete broker position/);
assert.equal(invalidQty.load().trades[0].tradeId, 'persisted-lot');
invalidPosition.stop();
console.log('runtime.check replay ok');

// September 25: terminal BUY denial must release the runtime for the next signal.
const deniedBroker = makeBroker();
let deniedSubmits = 0;
const normalSubmit = deniedBroker.submitOrder;
deniedBroker.submitOrder = async (order) => {
  if (++deniedSubmits === 1) throw Object.assign(new Error('Forbidden'), { httpStatus: 403 });
  return normalSubmit(order);
};
let executionWall = Date.parse('2026-09-23T10:00:00-04:00');
let executionMono = 0;
const deniedRuntime = createRuntime({ broker: deniedBroker, calendar, now: () => executionWall, nowMono: () => executionMono, continuity: continuity(), ...options });
try {
  await deniedRuntime.startup();
  deniedRuntime.onTrade({ timestamp: new Date(executionWall).toISOString(), price: 659 });
  executionWall += 30_000;
  deniedRuntime.onTrade({ timestamp: new Date(executionWall - 1).toISOString(), price: 659 });
  deniedRuntime.onTrade({ timestamp: new Date(executionWall).toISOString(), price: 660 });
  await flush(); await flush();
  assert.equal(deniedSubmits, 1);
  assert.equal(deniedRuntime.getState().state, 'FLAT');
  assert.equal(deniedRuntime.getState().entry.active, false);
  executionWall++;
  deniedRuntime.onTrade({ timestamp: new Date(executionWall).toISOString(), price: 661 });
  await flush(); await flush();
  assert.equal(deniedSubmits, 2, 'next eligible signal can submit after terminal 403');
  assert.equal(deniedRuntime.getState().state, 'BUYING');
} finally { deniedRuntime.stop(); }

// September 25 race: original fills while replacement response is still pending.
// A late replacement acknowledgement must hold re-entry until cancellation is terminal.
for (const childEvent of ['canceled', 'fill', 'unknown']) {
  let resolveReplacement, rejectReplacement;
  const cancellations = [];
  const events = [];
  const raceBroker = makeBroker();
  raceBroker.replaceOrder = () => new Promise((resolve, reject) => { resolveReplacement = resolve; rejectReplacement = reject; });
  raceBroker.cancelOrder = async (id) => { cancellations.push(id); };
  executionWall = Date.parse('2026-09-23T10:00:00-04:00'); executionMono = 0;
  const raceRuntime = createRuntime({ broker: raceBroker, calendar, now: () => executionWall, nowMono: () => executionMono, continuity: continuity(), ledger: (event) => events.push(event), ...options });
  try {
    await raceRuntime.startup();
    raceRuntime.onTrade({ timestamp: new Date(executionWall).toISOString(), price: 659 });
    executionWall += 30_000;
    raceRuntime.onTrade({ timestamp: new Date(executionWall - 1).toISOString(), price: 659 });
    raceRuntime.onTrade({ timestamp: new Date(executionWall).toISOString(), price: 660 });
    await flush(); await flush();
    const buy = [...raceBroker.orders.values()][0];
    raceRuntime.onOrderUpdate({ event: 'partial_fill', side: 'buy', orderId: buy.id, clientOrderId: buy.clientOrderId, executionId: 'race-buy', fillQty: 1, fillPrice: 1, timestamp: new Date(executionWall).toISOString() });
    raceRuntime.onOrderUpdate({ event: 'canceled', side: 'buy', orderId: buy.id, clientOrderId: buy.clientOrderId });
    executionWall += 10_000;
    raceRuntime.onQuote({ symbol, bid: 1, ask: 1.01, timestamp: new Date(executionWall).toISOString() });
    executionWall++;
    raceRuntime.onQuote({ symbol, bid: 1.10, ask: 1.11, timestamp: new Date(executionWall).toISOString() }); // establish trail peak and floor at 1.06
    await flush(); await flush();
    raceRuntime.onQuote({ symbol, bid: 1.05, ask: 1.06, timestamp: new Date(++executionWall).toISOString() });
    await flush(); await flush();
    const latchedSell = [...raceBroker.orders.values()].find((order) => order.side === 'sell');
    raceRuntime.onQuote({ symbol, bid: 1.04, ask: 1.05, timestamp: new Date(++executionWall).toISOString() });
    assert.equal(typeof resolveReplacement, 'function');
    raceRuntime.onOrderUpdate({ event: 'fill', side: 'sell', orderId: latchedSell.id, clientOrderId: latchedSell.clientOrderId, executionId: 'race-original', fillQty: 1, fillPrice: 1.05, timestamp: new Date(executionWall).toISOString() });
    executionMono = 5_000; raceRuntime.tick();
    assert.notEqual(raceRuntime.getState().state, 'FLAT', 'pending HTTP replacement blocks flat');
    if (childEvent === 'unknown') {
      rejectReplacement(Object.assign(new Error('replacement outcome unknown'), { httpStatus: 503 }));
      await flush(); await flush();
      raceRuntime.tick();
      assert.equal(raceRuntime.getState().state, 'BLOCKED_EXECUTION');
      assert.ok(raceRuntime.getState().blockers.some((issue) => issue.reason === 'SELL_REPLACE_UNKNOWN'));
      raceRuntime.onOrderUpdate({ event: 'new', side: 'sell', orderId: 'race-child', replaces: latchedSell.id });
      assert.equal(raceRuntime.hasOwnership(), true, 'known replacement child still pending after issue resolves');
      assert.deepEqual(raceRuntime.getState().blockers, []);
    } else resolveReplacement({ id: 'race-child', status: 'new' });
    await flush(); await flush();
    assert.deepEqual(cancellations, ['race-child']);
    raceRuntime.tick();
    assert.notEqual(raceRuntime.getState().state, 'FLAT', 'cancel HTTP acknowledgement is not terminal');
    raceRuntime.onOrderUpdate({ event: childEvent === 'unknown' ? 'canceled' : childEvent, side: 'sell', orderId: 'race-child', executionId: childEvent === 'fill' ? 'race-overfill' : undefined, fillQty: childEvent === 'fill' ? 1 : undefined, fillPrice: childEvent === 'fill' ? 1.09 : undefined });
    raceRuntime.tick();
    if (childEvent !== 'fill') {
      assert.equal(raceRuntime.getState().state, 'FLAT', 'original cooldown is honored after terminal child');
      assert.equal(raceRuntime.hasOwnership(), false);
    } else {
      assert.equal(raceRuntime.getState().state, 'BLOCKED_EXECUTION');
      assert.equal(raceRuntime.hasOwnership(), true, 'excess SELL cannot drain as flat');
      assert.ok(raceRuntime.getState().blockers.some((issue) => issue.reason === 'SELL_OVERFILL'));
      assert.equal(events.filter((event) => event.event === 'EXIT').length, 1, 'extra SELL is not a legitimate long exit');
      assert.equal(events.filter((event) => event.event === 'EXECUTION_ISSUE').length, 1);
    }
  } finally { raceRuntime.stop(); }
}
console.log('runtime.check September 25 execution integration ok');

// Lost-place recovery uses the same replacement settlement gate, including cancel failure recovery.
let recoveredSnapshot = { positions: [{ symbol, qty: 1 }], orders: [] };
let resolveRecoveryReplacement;
executionMono = 0;
const recoveryOrders = [];
const executionRecovery = createRuntime({
  broker: {
    inspectCurrentState: async () => recoveredSnapshot,
    submitOrder: async (order) => { recoveryOrders.push(order); return { id: 'recovery-original', status: 'new' }; },
    replaceOrder: () => new Promise((resolve) => { resolveRecoveryReplacement = resolve; }),
    cancelOrder: async () => { throw Object.assign(new Error('cancel failed'), { httpStatus: 503 }); },
  },
  calendar, now: () => executionWall, nowMono: () => executionMono, continuity: continuity(), ...options,
});
try {
  await executionRecovery.startup();
  assert.equal(executionRecovery.getState().state, 'RECOVERING');
  executionRecovery.onQuote({ symbol, bid: 1, ask: 1.01 });
  await flush(); await flush();
  executionRecovery.onQuote({ symbol, bid: 0.99, ask: 1 });
  recoveredSnapshot = { positions: [], orders: [] };
  executionRecovery.onOrderUpdate({ event: 'fill', side: 'sell', orderId: 'recovery-original', executionId: 'recovery-filled', fillQty: 1, fillPrice: 1 });
  await flush(); await flush();
  executionMono = 5_000; executionRecovery.tick();
  assert.notEqual(executionRecovery.getState().state, 'FLAT');
  resolveRecoveryReplacement({ id: 'recovery-child', status: 'new' });
  await flush(); await flush();
  assert.equal(executionRecovery.getState().state, 'BLOCKED_EXECUTION');
  assert.ok(executionRecovery.getState().blockers.some((issue) => issue.reason === 'SELL_CANCEL_FAILED'));
  executionRecovery.onOrderUpdate({ event: 'canceled', side: 'sell', orderId: 'recovery-child' });
  executionRecovery.tick();
  assert.equal(executionRecovery.getState().state, 'FLAT', 'terminal child resolves cancellation issue and recovery');
  assert.deepEqual(executionRecovery.getState().blockers, []);
  assert.equal(executionRecovery.hasOwnership(), false);
} finally { executionRecovery.stop(); }
console.log('runtime.check recovery execution settlement ok');

// Session-only override reaches both gates; asynchronous selection cannot buy after cutoff.
for (const [clock, allow] of [['13:00:00.000', true], ['15:24:59.999', true], ['15:25:00.000', false]]) {
  const b = makeBroker();
  const at = Date.parse(`2026-09-23T${clock}-04:00`);
  let t = at - 31_000;
  const r = createRuntime({ broker: b, calendar, now: () => t, nowMono: () => 0, continuity: continuity(), ...options, entryCutoffMinuteET: 925 });
  try {
    await r.startup(); t = at;
    r.onTrade({ timestamp: new Date(t - 1).toISOString(), price: 659 });
    r.onTrade({ timestamp: new Date(t).toISOString(), price: 660 });
    await flush(); await flush();
    assert.equal(b.orders.size > 0, allow, `${clock} override boundary`);
  } finally { r.stop(); }
}
for (const [clock, allow] of [['15:29:59.999', true], ['15:30:00.000', false]]) {
  const b = makeBroker();
  const at = Date.parse(`2026-09-23T${clock}-04:00`);
  let t = at - 31_000;
  const r = createRuntime({ broker: b, calendar, now: () => t, nowMono: () => 0, continuity: continuity(), ...options });
  try {
    await r.startup(); t = at;
    r.onTrade({ timestamp: new Date(t - 1).toISOString(), price: 659 });
    r.onTrade({ timestamp: new Date(t).toISOString(), price: 660 });
    await flush(); await flush();
    assert.equal(b.orders.size > 0, allow, `${clock} broker cutoff`);
  } finally { r.stop(); }
}

{
  const b = makeBroker();
  let t = Date.parse('2026-09-23T13:32:31Z'), monoAt = 0;
  const r = createRuntime({ broker: b, calendar, now: () => t, nowMono: () => monoAt, continuity: continuity(), ...options });
  try {
    await r.startup();
    r.stopEntries();
    t += 31_000; monoAt += 31_000;
    r.onTrade({ timestamp: new Date(t - 1).toISOString(), price: 659 });
    r.onTrade({ timestamp: new Date(t).toISOString(), price: 660 });
    await flush(); await flush();
    assert.equal(b.orders.size, 0, 'stopEntries prevents a new BUY while leaving runtime management active');
  } finally { r.stop(); }
}
{
  const b = makeBroker();
  let t = Date.parse('2026-09-23T15:29:28-04:00'), resolveContracts;
  const r = createRuntime({ broker: b, calendar, now: () => t, nowMono: () => 0, continuity: continuity(), ...options,
    getContracts: () => new Promise((resolve) => { resolveContracts = resolve; }) });
  try {
    await r.startup(); t += 31_000;
    r.onTrade({ timestamp: new Date(t - 1).toISOString(), price: 659 });
    r.onTrade({ timestamp: new Date(t).toISOString(), price: 660 });
    t += 1_000; resolveContracts([{ symbol, strike: 660 }]);
    await flush(); await flush();
    assert.equal(b.orders.size, 0, 'selection crossing broker 15:30 cutoff cannot submit BUY');
  } finally { r.stop(); }
}
{
  const b = makeBroker();
  let t = Date.parse('2026-09-23T15:24:28-04:00'), resolveContracts;
  const r = createRuntime({ broker: b, calendar, now: () => t, nowMono: () => 0, continuity: continuity(), ...options,
    entryCutoffMinuteET: 925, stopAtMs: Date.parse('2026-09-23T15:25:00-04:00'), getContracts: () => new Promise((resolve) => { resolveContracts = resolve; }) });
  try {
    await r.startup(); t += 31_000;
    r.onTrade({ timestamp: new Date(t - 1).toISOString(), price: 659 });
    r.onTrade({ timestamp: new Date(t).toISOString(), price: 660 });
    t += 1_000; resolveContracts([{ symbol, strike: 660 }]);
    await flush(); await flush();
    assert.equal(b.orders.size, 0, 'selection crossing 15:25 does not submit');
    assert.equal(r.getState().state, 'FLAT');
  } finally { r.stop(); }
}

{
  const b = makeBroker();
  let t = Date.parse('2026-09-23T15:24:28-04:00'), resolveContracts;
  const absoluteStop = Date.parse('2026-09-23T15:25:00-04:00');
  const r = createRuntime({ broker: b, calendar, now: () => t, nowMono: () => 0, continuity: continuity(), ...options,
    entryCutoffMinuteET: 925, stopAtMs: absoluteStop, getContracts: () => new Promise((resolve) => { resolveContracts = resolve; }) });
  try {
    await r.startup(); t += 31_000;
    r.onTrade({ timestamp: new Date(t - 1).toISOString(), price: 659 });
    r.onTrade({ timestamp: new Date(t).toISOString(), price: 660 });
    t = Date.parse('2026-09-24T10:00:00-04:00'); resolveContracts([{ symbol, strike: 660 }]);
    await flush(); await flush();
    assert.equal(b.orders.size, 0, 'absolute stop blocks pending selection even with permissive stale calendar next morning');
  } finally { r.stop(); }
}
