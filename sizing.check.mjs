import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createContinuity } from './continuity.mjs';
import { createEntry } from './entry.mjs';
import { createRuntime } from './runtime.mjs';

const symbol = 'SPY260923C00660000';
const date = '2026-09-23';
const session = (day = date) => ({ date: day, status: 'open', open: `${day}T13:30:00Z`, close: `${day}T20:00:00Z` });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function entryHarness({ quantity = 1, strategyCapital = 500, contracts, quotes, onFill = () => {} }) {
  const calls = [];
  const quoteCalls = [];
  const broker = {
    async submitOrder(order) { calls.push({ kind: 'submit', ...order }); return { id: `o${calls.length}`, status: 'accepted' }; },
    async replaceOrder(id, order) { calls.push({ kind: 'replace', id, ...order }); return { id: `r${calls.length}`, status: 'accepted' }; },
    async cancelOrder(id) { calls.push({ kind: 'cancel', id }); },
  };
  const entry = createEntry({ broker, quantity, strategyCapital,
    getContracts: async () => contracts,
    getQuote: async (name) => { quoteCalls.push(name); return quotes[name]; },
    onFill, onState: () => {}, nowMono: () => 0,
  });
  return { entry, calls, quoteCalls };
}

const contracts = [
  { symbol: 'ATM', strike: 100 },
  { symbol: 'OTM1', strike: 101 },
  { symbol: 'OTM2', strike: 102 },
];

// The frozen midpoint-plus-three-cent cap permits exact budget equality.
{
  const { entry, calls } = entryHarness({ contracts: [contracts[0]], quotes: { ATM: { bid: 4.97, ask: 4.97 } } });
  await entry.onBreakout({ direction: 'CALL', timestamp: 1, spyPrice: 100 });
  assert.equal(calls.filter((x) => x.kind === 'submit').length, 1);
  assert.equal(calls[0].qty, 1);
  assert.equal(calls[0].limitPrice, 4.97);
  assert.equal(entry.getState().cap, 5);
}

// If the selected ATM contract exceeds the strategy budget, do not search for
// cheaper strikes; selection remains limited to ATM and its first directional OTM.
{
  const { entry, calls, quoteCalls } = entryHarness({ contracts, quotes: {
    ATM: { bid: 4.98, ask: 5 }, OTM1: { bid: 0.5, ask: 0.52 }, OTM2: { bid: 0.1, ask: 0.12 },
  } });
  await entry.onBreakout({ direction: 'CALL', timestamp: 2, spyPrice: 100 });
  assert.equal(calls.filter((x) => x.kind === 'submit').length, 0, 'over-budget selection is rejected');
  assert.deepEqual(quoteCalls, ['ATM'], 'do not fall through to cheaper strikes after budget rejection');
}

// The cap is frozen at selection and every reprice stays within it. Once a
// one-contract entry is owned, another breakout cannot create another order.
{
  const fills = [];
  let currentQuote = { bid: 4.8, ask: 4.82 };
  const broker = {
    calls: [],
    async submitOrder(order) { this.calls.push({ kind: 'submit', ...order }); return { id: 'owned-buy', status: 'accepted' }; },
    async replaceOrder(id, order) { this.calls.push({ kind: 'replace', id, ...order }); return { id: 'owned-buy-r', status: 'accepted' }; },
    async cancelOrder(id) { this.calls.push({ kind: 'cancel', id }); },
  };
  const entry = createEntry({ broker, quantity: 1, strategyCapital: 500,
    getContracts: async () => contracts,
    getQuote: async () => currentQuote,
    onFill: (fill) => fills.push(fill), onState: () => {}, nowMono: () => 0,
  });
  await entry.onBreakout({ direction: 'CALL', timestamp: 3, spyPrice: 100 });
  const frozenCap = entry.getState().cap;
  currentQuote = { bid: 4.82, ask: 4.84 };
  entry.tick();
  await flush();
  assert.equal(entry.getState().cap, frozenCap);
  assert.equal(broker.calls.filter((x) => x.kind === 'replace').length, 1, 'repricing up to the frozen cap is allowed');
  assert.ok(Math.abs(broker.calls.find((x) => x.kind === 'replace').limitPrice - frozenCap) < 1e-9);
  currentQuote = { bid: 4.83, ask: 4.85 };
  entry.tick();
  await flush();
  assert.equal(broker.calls.filter((x) => x.kind === 'replace').length, 1, 'repricing above the frozen cap is refused');
  const clientOrderId = entry.getState().clientOrderId;
  entry.onOrderUpdate({ event: 'fill', side: 'buy', clientOrderId, orderId: 'owned-buy', executionId: 'one-fill',
    fillQty: 1, fillPrice: 4.82, timestamp: '2026-09-23T14:00:00Z' });
  assert.equal(fills.length, 1);
  assert.equal(entry.getState().filled, 1);
  await entry.onBreakout({ direction: 'CALL', timestamp: 4, spyPrice: 100 });
  assert.equal(broker.calls.filter((x) => x.kind === 'submit').length, 1, 'no second signal while the entry is owned');
}

function runtimeHarness({ continuity = createContinuity({ path: join(mkdtempSync(join(tmpdir(), 'v5-sizing-')), 'state.json') }),
  broker, day = date, strategyCapital = 500, dailyLossGuard = true, entryQuantity = 1,
  clock = { wall: Date.parse(`${day}T14:00:00Z`), mono: 0 } } = {}) {
  return createRuntime({ broker, continuity, strategyCapital, entryQuantity, dailyLossGuard,
    now: () => clock.wall, nowMono: () => clock.mono,
    calendar: { sessionFor: () => session(day) },
    getContracts: async () => [{ symbol, strike: 660 }],
    getQuote: async () => ({ symbol, bid: 1, ask: 1.01, timestamp: `${day}T14:00:00Z` }),
  });
}

function brokerState({ equity = 10_000, positions = [], orders = [] } = {}) {
  const calls = [];
  const currentOrders = new Map(orders.map((order) => [order.id, { ...order }]));
  return {
    calls, orders: currentOrders,
    async inspectCurrentState() { return { account: { equity }, positions: positions.map((x) => ({ ...x })), orders: [...currentOrders.values()].map((x) => ({ ...x })) }; },
    async submitOrder(order) { calls.push({ ...order }); const id = `buy-${calls.length}`; currentOrders.set(id, { ...order, id, status: 'accepted' }); return { id, status: 'accepted' }; },
    async replaceOrder(id, order) { calls.push({ id, ...order }); return { id, status: 'accepted' }; },
    async cancelOrder() {},
  };
}

async function breakout(runtime, prefix) {
  runtime.onTrade({ timestamp: `${date}T14:00:00.000Z`, price: 100, tradeId: `${prefix}-range` });
  runtime.onTrade({ timestamp: `${date}T14:00:01.000Z`, price: 101, tradeId: `${prefix}-break` });
  await flush(); await flush();
}

// The PAPER runtime's one-contract quantity reaches a completed BUY/SELL set;
// the realized contract loss is recorded once and stays below the $50 guard.
{
  const continuity = createContinuity({ path: join(mkdtempSync(join(tmpdir(), 'v5-sizing-cycle-')), 'state.json') });
  const broker = brokerState();
  const clock = { wall: Date.parse(`${date}T14:00:00Z`), mono: 0 };
  const runtime = runtimeHarness({ continuity, broker, clock });
  try {
    await runtime.startup();
    clock.wall += 31_000; clock.mono += 31_000;
    runtime.onTrade({ timestamp: new Date(clock.wall).toISOString(), price: 100, tradeId: 'cycle-range' });
    clock.wall += 1_000; clock.mono += 1_000;
    runtime.onTrade({ timestamp: new Date(clock.wall).toISOString(), price: 101, tradeId: 'cycle-break' });
    await flush(); await flush();
    const buy = [...broker.orders.values()].find((order) => order.side === 'buy');
    assert.ok(buy, 'one-contract breakout submits a BUY');
    assert.equal(buy.qty, 1);
    clock.wall += 100; clock.mono += 100;
    runtime.onOrderUpdate({ event: 'fill', side: 'buy', orderId: buy.id, clientOrderId: buy.clientOrderId,
      executionId: 'cycle-buy-fill', fillQty: 1, fillPrice: 1.01, timestamp: new Date(clock.wall).toISOString() });
    clock.wall += 10_001; clock.mono += 10_001;
    runtime.onQuote({ symbol, bid: 1, ask: 1.01, timestamp: new Date(clock.wall).toISOString() });
    clock.wall += 100; clock.mono += 100;
    runtime.onQuote({ symbol, bid: 0.89, ask: 0.90, timestamp: new Date(clock.wall).toISOString() });
    await flush(); await flush();
    const sell = [...broker.orders.values()].find((order) => order.side === 'sell');
    assert.ok(sell, 'filled ownership receives its protective SELL');
    assert.equal(sell.qty, 1);
    clock.wall += 100; clock.mono += 100;
    runtime.onOrderUpdate({ event: 'fill', side: 'sell', orderId: sell.id, clientOrderId: sell.clientOrderId,
      executionId: 'cycle-sell-fill', fillQty: 1, fillPrice: 0.80, timestamp: new Date(clock.wall).toISOString() });
    assert.equal(runtime.getState().dailyLoss.cumulativeRealizedGross, -21);
    assert.equal(runtime.getState().dailyLoss.tripped, false);
    assert.deepEqual(runtime.getState().dailyLoss.completedBuyIds, [buy.clientOrderId]);
    assert.ok(runtime.getState().lossPauseUntil > clock.wall, 'completed losing set retains its ordinary loss pause');
  } finally { runtime.stop(); }
}

// A completed one-contract loss at exactly 10% of $500 trips the guard;
// just below remains available and just above is also sticky.
for (const [label, loss, expected] of [['below', -49.99, false], ['exact', -50, true], ['above', -50.01, true]]) {
  const continuity = createContinuity({ path: join(mkdtempSync(join(tmpdir(), 'v5-sizing-loss-')), 'state.json') });
  continuity.save([], { pause: null, sets: [{ tradeSetId: `set-${label}`, date, known: true,
    entryQty: 1, entryCentQty: 100, exitQty: 1, exitCentQty: 100 + loss,
    entryTerminal: true, closedAt: Date.parse(`${date}T13:59:00Z`) }],
    dailyLoss: { date, dayStartEquity: 500, cumulativeRealizedGross: 0, tripped: false, completedBuyIds: [] } });
  const broker = brokerState();
  const runtime = runtimeHarness({ continuity, broker });
  try {
    await runtime.startup();
    assert.equal(runtime.getState().dailyLoss.dayStartEquity, 500);
    assert.equal(runtime.getState().dailyLoss.cumulativeRealizedGross, loss);
    assert.equal(runtime.getState().dailyLoss.tripped, expected, `${label} threshold result`);
    assert.deepEqual(runtime.getState().dailyLoss.completedBuyIds, [`set-${label}`]);
  } finally { runtime.stop(); }
}

// Restored state keeps the budget frozen at its DAY_START baseline while
// preserving the day's existing realized P&L, dedup IDs, and sticky trip.
{
  const continuity = createContinuity({ path: join(mkdtempSync(join(tmpdir(), 'v5-sizing-restore-')), 'state.json') });
  const prior = { date, dayStartEquity: 9_744.81, cumulativeRealizedGross: -12.5, tripped: true, completedBuyIds: ['buy-a', 'buy-b'] };
  continuity.save([], { pause: null, sets: [], dailyLoss: prior });
  const runtime = runtimeHarness({ continuity, broker: brokerState({ equity: 9_744.81 }) });
  try {
    await runtime.startup();
    assert.deepEqual(runtime.getState().dailyLoss, { ...prior, peakRealizedGross: 0 }, 'restored daily-loss state retains accounting and its DAY_START baseline');
  } finally { runtime.stop(); }
}

// A new day starts a fresh $500 baseline and clears yesterday's trip.
{
  const continuity = createContinuity({ path: join(mkdtempSync(join(tmpdir(), 'v5-sizing-nextday-')), 'state.json') });
  continuity.save([], { pause: null, sets: [], dailyLoss: { date, dayStartEquity: 9_744.81,
    cumulativeRealizedGross: -20, tripped: true, completedBuyIds: ['old-buy'] } });
  const tomorrow = '2026-09-24';
  const runtime = runtimeHarness({ continuity, day: tomorrow, broker: brokerState({ equity: 9_744.81 }) });
  try {
    await runtime.startup();
    assert.deepEqual(runtime.getState().dailyLoss, { date: tomorrow, dayStartEquity: 500,
      cumulativeRealizedGross: 0, peakRealizedGross: 0, tripped: false, completedBuyIds: [] });
  } finally { runtime.stop(); }
}

const paperSource = readFileSync(new URL('./paper.mjs', import.meta.url), 'utf8');
assert.match(paperSource, /dailyLossGuard:\s*true/);
assert.match(paperSource, /strategyCapital:\s*500,\s*entryQuantity:\s*1/,
  'the $500 capital and one-contract size are enabled for guarded PAPER and LIVE sessions');

console.log('sizing.check ok');
