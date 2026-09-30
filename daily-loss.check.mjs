import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContinuity } from './continuity.mjs';
import { createRuntime } from './runtime.mjs';

const symbol = 'SPY260923C00660000';
const date = '2026-09-23';
const session = (day = date) => ({ date: day, status: 'open', open: `${day}T13:30:00Z`, close: `${day}T20:00:00Z` });
const stateFile = () => join(mkdtempSync(join(tmpdir(), 'v5-daily-loss-')), 'state.json');
const flush = () => new Promise((resolve) => setImmediate(resolve));

let wall = Date.parse('2026-09-23T14:00:00Z');
let mono = 0;
function brokerWith({ positions = [], orders = [], equity = 10_000 } = {}) {
  const currentOrders = new Map(orders.map((order) => [order.id, { ...order }]));
  const calls = [];
  let nextId = 1;
  return {
    calls,
    orders: currentOrders,
    inspectCurrentState: async () => ({ account: { equity }, positions: positions.map((p) => ({ ...p })), orders: [...currentOrders.values()].map((o) => ({ ...o })) }),
    submitOrder: async (order) => { calls.push({ ...order }); const id = `o${nextId++}`; currentOrders.set(id, { ...order, id, status: 'accepted' }); return { id, status: 'accepted' }; },
    replaceOrder: async (id, order) => { calls.push({ replace: id, ...order }); const next = `o${nextId++}`; currentOrders.set(next, { ...currentOrders.get(id), ...order, id: next, status: 'accepted' }); return { id: next, status: 'accepted' }; },
    cancelOrder: async (id) => { const order = currentOrders.get(id); if (order) order.status = 'pending_cancel'; },
  };
}
function runtime({ continuity, broker, day = date, dailyLossGuard = true }) {
  return createRuntime({ broker, continuity, dailyLossGuard, now: () => wall, nowMono: () => mono,
    calendar: { sessionFor: () => session(day) }, getContracts: async () => [{ symbol, strike: 660 }],
    getQuote: async () => ({ symbol, bid: 1, ask: 1.01, timestamp: new Date(wall).toISOString() }),
  });
}
function closedSet(tradeSetId, { lossDollars, closedAt = wall - 1_000 } = {}) {
  // Ten contracts at $1.00, with the corresponding exit total encoding the
  // requested dollar gross result in the existing per-set continuity units.
  const entryCentQty = 1_000;
  const exitCentQty = entryCentQty + lossDollars;
  return { tradeSetId, date, known: true, entryQty: 10, entryCentQty, exitQty: 10,
    exitCentQty, entryTerminal: true, closedAt };
}
async function initialize(continuity, broker, sets = [], dailyLoss = null, day = date) {
  continuity.save([], { pause: null, sets, dailyLoss });
  const r = runtime({ continuity, broker, day });
  await r.startup();
  return r;
}
async function sendBreakout(r, label = 'daily-loss') {
  wall += 31_000; mono += 31_000;
  r.onTrade({ timestamp: new Date(wall).toISOString(), price: 100, tradeId: `${label}-range` });
  wall += 1_000; mono += 1_000;
  r.onTrade({ timestamp: new Date(wall).toISOString(), price: 101, tradeId: `${label}-break` });
  await flush(); await flush();
}

// Completed losing sets add their realized gross once. The exact -2.5% boundary
// trips, including when an earlier completed set is replayed after restart.
wall = Date.parse('2026-09-23T14:00:00Z'); mono = 0;
const exactContinuity = createContinuity({ path: stateFile() });
const exactBaseline = { date, dayStartEquity: 10_000, cumulativeRealizedGross: -150, tripped: false, completedBuyIds: ['buy-1'] };
const exactBroker = brokerWith();
const exact = await initialize(exactContinuity, exactBroker, [closedSet('buy-1', { lossDollars: -150 }), closedSet('buy-2', { lossDollars: -100 })], exactBaseline);
try {
  const daily = exact.getState().dailyLoss;
  assert.equal(daily.cumulativeRealizedGross, -250, 'cumulative completed gross is in account dollars');
  assert.equal(daily.tripped, true, 'the exact 2.5% loss boundary trips');
  assert.deepEqual(daily.completedBuyIds, ['buy-1', 'buy-2'], 'replayed completion is deduplicated');
  assert.ok(exact.getState().lossPauseUntil > wall, 'the existing 60-second losing-set pause remains active');
  const buyCount = exactBroker.calls.filter((order) => order.side === 'buy').length;
  await sendBreakout(exact, 'at-boundary');
  assert.equal(exactBroker.calls.filter((order) => order.side === 'buy').length, buyCount, 'trip suppresses new BUY entries');
  wall = exact.getState().lossPauseUntil + 1; mono += 61_000; exact.tick();
  assert.equal(exact.getState().state, 'FLAT', 'ordinary losing-set pause expires normally');
  await sendBreakout(exact, 'after-pause');
  assert.equal(exact.getState().dailyLoss.tripped, true, 'daily trip remains sticky after 60 seconds');
  assert.equal(exactBroker.calls.filter((order) => order.side === 'buy').length, buyCount, 'sticky trip still suppresses BUY after the 60-second pause expires');
} finally { exact.stop(); }

// A loss above the boundary does not trip; exact zero and positive completed
// gross do not become losses. A same-day process restart retains the P&L state.
wall = Date.parse('2026-09-23T14:00:00Z'); mono = 0;
const aboveContinuity = createContinuity({ path: stateFile() });
const aboveState = { date, dayStartEquity: 10_000, cumulativeRealizedGross: -249.99, tripped: false, completedBuyIds: ['prior'] };
const aboveBroker = brokerWith();
const above = await initialize(aboveContinuity, aboveBroker, [closedSet('zero-result', { lossDollars: 0 }), closedSet('profit-result', { lossDollars: 5 })], aboveState);
try {
  assert.equal(above.getState().dailyLoss.cumulativeRealizedGross, -244.99);
  assert.equal(above.getState().dailyLoss.tripped, false, 'loss above threshold does not trip');
  const beforeRestart = above.getState().dailyLoss;
  above.stop();
  const restarted = runtime({ continuity: aboveContinuity, broker: aboveBroker });
  try {
    await restarted.startup();
    assert.deepEqual(restarted.getState().dailyLoss, beforeRestart, 'same-day restart preserves baseline, totals, and dedup IDs');
    const buysBefore = aboveBroker.calls.filter((order) => order.side === 'buy').length;
    await sendBreakout(restarted, 'below-threshold-control');
    const buy = [...aboveBroker.orders.values()].find((order) => order.side === 'buy');
    assert.ok(buy, 'below-threshold PAPER guard allows a new BUY');
    assert.equal(aboveBroker.calls.filter((order) => order.side === 'buy').length, buysBefore + 1);
    for (const [index, event] of ['partial_fill', 'partial_fill'].entries()) {
      wall += 100; mono += 100;
      restarted.onOrderUpdate({ event, side: 'buy', orderId: buy.id, clientOrderId: buy.clientOrderId,
        executionId: `paper-buy-${index}`, fillQty: 1, fillPrice: 1, timestamp: new Date(wall).toISOString() });
    }
    wall += 100; mono += 100;
    restarted.onOrderUpdate({ event: 'canceled', side: 'buy', orderId: buy.id, clientOrderId: buy.clientOrderId });
    wall += 10_001; mono += 10_001;
    restarted.onQuote({ symbol, bid: 1, ask: 1.01, timestamp: new Date(wall).toISOString() });
    wall += 100; mono += 100;
    restarted.onQuote({ symbol, bid: 1.02, ask: 1.03, timestamp: new Date(wall).toISOString() });
    wall += 100; mono += 100;
    restarted.onQuote({ symbol, bid: 0.89, ask: 0.90, timestamp: new Date(wall).toISOString() });
    await flush(); await flush();
    const sells = [...aboveBroker.orders.values()].filter((order) => order.side === 'sell');
    assert.equal(sells.length, 2, 'existing trail submits SELL orders for both filled contracts');
    const soldAt = wall + 100;
    for (const sell of sells) {
      wall = soldAt; mono += 100;
      restarted.onOrderUpdate({ event: 'fill', side: 'sell', orderId: sell.id, clientOrderId: sell.clientOrderId,
        executionId: `paper-sell-${sell.id}`, fillQty: 1, fillPrice: 0.80, timestamp: new Date(wall).toISOString() });
    }
    assert.equal(restarted.getState().dailyLoss.cumulativeRealizedGross, -284.99, 'broker-confirmed BUY and SELL fills update cumulative gross in USD');
    assert.equal(restarted.getState().dailyLoss.tripped, true, 'the broker-confirmed cycle crosses the daily limit');
    const tripState = restarted.getState().dailyLoss;
    restarted.stop();
    const tripRestart = runtime({ continuity: aboveContinuity, broker: brokerWith() });
    try {
      await tripRestart.startup();
      assert.deepEqual(tripRestart.getState().dailyLoss, tripState, 'same-day restart preserves a tripped state without adding completed gross again');
    } finally { tripRestart.stop(); }
  } finally { restarted.stop(); }
} finally { above.stop(); }

// A new trading date starts a new baseline from that day's authenticated
// broker snapshot and clears yesterday's sticky trip.
wall = Date.parse('2026-09-24T14:00:00Z'); mono = 0;
const nextDayBroker = brokerWith({ equity: 8_000 });
const nextDay = runtime({ continuity: aboveContinuity, broker: nextDayBroker, day: '2026-09-24' });
try {
  await nextDay.startup();
  assert.deepEqual(nextDay.getState().dailyLoss, { date: '2026-09-24', dayStartEquity: 8_000, cumulativeRealizedGross: 0, tripped: false, completedBuyIds: [] });
} finally { nextDay.stop(); }

// Fractional baseline equity is rounded at the currency boundary: $2.51 is
// exactly 2.5% of $100.40 and must trip rather than miss from binary rounding.
wall = Date.parse('2026-09-23T14:00:00Z'); mono = 0;
const fractionalContinuity = createContinuity({ path: stateFile() });
const fractionalBroker = brokerWith({ equity: 100.40 });
fractionalContinuity.save([], { pause: null, sets: [closedSet('fractional-loss', { lossDollars: -2.51 })] });
const fractional = runtime({ continuity: fractionalContinuity, broker: fractionalBroker });
try {
  await fractional.startup();
  assert.equal(fractional.getState().dailyLoss.dayStartEquity, 100.40);
  assert.equal(fractional.getState().dailyLoss.cumulativeRealizedGross, -2.51);
  assert.equal(fractional.getState().dailyLoss.tripped, true, '$2.51 loss trips at 2.5% of $100.40');
} finally { fractional.stop(); }

// PAPER wiring is explicit: production enables the daily-loss guard only for
// PAPER mode, while generic/non-PAPER runtimes leave it disabled by default.
const paperSource = readFileSync(new URL('./paper.mjs', import.meta.url), 'utf8');
assert.match(paperSource, /dailyLossGuard:\s*mode\s*===\s*['"]paper['"]/);

// Daily loss gates new entries only. An already-owned position keeps its SELL
// order lifecycle while the trip is active.
wall = Date.parse('2026-09-23T14:00:00Z'); mono = 0;
const ownedContinuity = createContinuity({ path: stateFile() });
const ownedTrade = { tradeId: 'owned-1', executionId: 'owned-buy', symbol, entryPrice: 1, contractSize: 100,
  contractSizeSource: 'alpaca_contract_metadata', fillTimestampMs: wall - 20_000, anchorBid: null,
  anchorSetAtMs: null, anchorSourceTimestamp: null, remainingQty: 1, profitFloor: null,
  sellLatched: true, logicalSellId: 'owned-sell', orderId: 'sell-1', signalId: 'signal-owned', tradeSetId: 'owned-set' };
const ownedSellBroker = brokerWith({ positions: [{ symbol, qty: 1 }], orders: [{ id: 'sell-1', symbol, side: 'sell', qty: 1,
  filled_qty: 0, status: 'accepted', client_order_id: 'owned-sell' }] });
const trippedState = { date, dayStartEquity: 10_000, cumulativeRealizedGross: -250, tripped: true, completedBuyIds: ['prior-loss'] };
ownedContinuity.save([ownedTrade], { pause: null, sets: [], dailyLoss: trippedState });
const owned = runtime({ continuity: ownedContinuity, broker: ownedSellBroker });
try {
  await owned.startup();
  wall += 1_000;
  owned.onOrderUpdate({ event: 'fill', side: 'sell', orderId: 'sell-1', clientOrderId: 'owned-sell',
    executionId: 'owned-sell-fill', fillQty: 1, fillPrice: 1.1, timestamp: new Date(wall).toISOString() });
  assert.equal(ownedContinuity.load().status, 'compatible', 'owned SELL fill is processed and clears the resolved position');
  assert.equal(owned.getState().dailyLoss.tripped, true, 'SELL processing does not clear the daily trip');
  assert.ok(ownedSellBroker.calls.every((order) => order.side === 'sell'), 'guard does not submit a new BUY while managing ownership');
} finally { owned.stop(); }

// Establishing a missing same-date baseline must retain restored ownership and
// in-flight set accounting through every startup continuity write.
wall = Date.parse('2026-09-23T14:00:00Z'); mono = 0;
const startupContinuity = createContinuity({ path: stateFile() });
const startupSet = { tradeSetId: 'owned-set', date, known: true, entryQty: 1, entryCentQty: 100,
  exitQty: 0, exitCentQty: 0, entryTerminal: false, closedAt: null };
startupContinuity.save([ownedTrade], { pause: null, sets: [startupSet] });
const startupBroker = brokerWith({ positions: [{ symbol, qty: 1 }], orders: [{ id: 'sell-1', symbol, side: 'sell', qty: 1,
  filled_qty: 0, status: 'accepted', client_order_id: 'owned-sell' }] });
const startupWithMissingDaily = runtime({ continuity: startupContinuity, broker: startupBroker });
try {
  await startupWithMissingDaily.startup();
  const loaded = startupContinuity.load();
  assert.equal(loaded.status, 'compatible');
  assert.equal(loaded.trades.length, 1, 'baseline write retains the saved owned position');
  assert.equal(loaded.sets.length, 1, 'baseline write retains incomplete BUY accounting');
  assert.equal(loaded.dailyLoss.dayStartEquity, 10_000, 'authenticated equity baseline is persisted');
} finally { startupWithMissingDaily.stop(); }

// The guard is opt-in at runtime (paper.mjs enables it only in PAPER mode),
// and the existing 15:30 entry cutoff still applies.
wall = Date.parse('2026-09-23T15:30:00-04:00'); mono = 0;
const cutoffBroker = brokerWith();
const cutoff = runtime({ continuity: createContinuity({ path: stateFile() }), broker: cutoffBroker, dailyLossGuard: false });
try {
  await cutoff.startup();
  assert.equal(cutoff.getState().dailyLoss, undefined, 'non-PAPER runtime has no daily guard state');
  await sendBreakout(cutoff, 'cutoff');
  assert.equal(cutoffBroker.calls.filter((order) => order.side === 'buy').length, 0, 'the 15:30 BUY cutoff remains in force');
} finally { cutoff.stop(); }

console.log('daily-loss.check ok');
