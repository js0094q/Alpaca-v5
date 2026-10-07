import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContinuity, reconcileContinuity } from './continuity.mjs';
import { createAlpacaBroker } from './alpaca.mjs';
import { createPositions } from './positions.mjs';
import { createRuntime } from './runtime.mjs';

const root = mkdtempSync(join(tmpdir(), 'v5-continuity-'));
const path = join(root, 'state.json');
const c = createContinuity({ path });
const trade = { tradeId: 't1', executionId: 'e1', symbol: 'SPY260921C00660000', entryPrice: 1.23, contractSize: null, contractSizeSource: null, fillTimestampMs: 1_000, anchorBid: null, anchorSetAtMs: null, anchorSourceTimestamp: null, remainingQty: 1, profitFloor: null, sellLatched: false, logicalSellId: null, orderId: null, signalId: null, tradeSetId: null, mfeCents: 0, maeCents: 0, exitReason: null, reconciling: false };
const trade2 = { ...trade, tradeId: 't2', executionId: 'e2', symbol: 'SPY260921P00650000', entryPrice: 0.87, remainingQty: 1 };

c.save([trade, trade2]);
assert.equal(reconcileContinuity({ positions: [] }, c.load()).status, 'flat'); // 1. clean FLAT restart
assert.equal(reconcileContinuity({ positions: [{ symbol: trade.symbol, qty: 1 }, { symbol: trade2.symbol, qty: 1 }] }, c.load()).status, 'compatible'); // 2. each fill restores
assert.equal(reconcileContinuity({ positions: [{ symbol: trade.symbol, qty: 1 }, { symbol: trade2.symbol, qty: 1 }], orders: [{ symbol: 'QQQ260921C00100000', side: 'sell', status: 'new', qty: 99 }] }, c.load()).status, 'compatible'); // unrelated order ignored
assert.deepEqual(c.load().trades, [trade, trade2]);
assert.match(readFileSync(path, 'utf8'), /"version":1/);
const linkedTrade = { ...trade, signalId: 'signal-7', tradeSetId: 'v5-buy-set', anchorBid: 1.2, anchorSetAtMs: 2_000, anchorSourceTimestamp: '2026-09-21T13:00:02.000Z' };
c.save([linkedTrade]);
assert.deepEqual([c.load().trades[0].signalId, c.load().trades[0].tradeSetId, c.load().trades[0].anchorSetAtMs, c.load().trades[0].anchorSourceTimestamp], ['signal-7', 'v5-buy-set', 2_000, '2026-09-21T13:00:02.000Z']);
c.save([trade, trade2]);
c.save([{ ...trade, anchorBid: 1.2 }]);
assert.equal(c.load().trades[0].anchorBid, 1.2); // immutable T+10 anchor survives restart
c.save([trade, trade2]);
c.save([{ ...trade, anchorBid: 1.2, profitFloor: 1.28 }]); // 3. +$0.05 from max(entry, raw anchor) survives
assert.deepEqual([c.load().trades[0].anchorBid, c.load().trades[0].profitFloor], [1.2, 1.28]);
c.save([{ ...trade, anchorBid: 1.2, profitFloor: 1.31 }]); // 4. +$0.08 from max(entry, raw anchor) survives
assert.deepEqual([c.load().trades[0].anchorBid, c.load().trades[0].profitFloor], [1.2, 1.31]);
assert.equal((c.save([{ ...trade, anchorBid: 1.2, profitFloor: 1.21 }]), c.load().trades[0].profitFloor), 1.21); // initial trail floor may start 2c below reference
assert.throws(() => c.save([{ ...trade, anchorBid: 1.2, profitFloor: 1.20 }]), /invalid active continuity state/); // reject a floor below the permitted trail start
const legacyProtected = { tradeId: 'legacy', executionId: 'legacy-buy', symbol: trade.symbol, entryPrice: 1.23, fillTimestampMs: 1_000, remainingQty: 1, profitFloor: 1.28, sellLatched: false, logicalSellId: null, orderId: null };
writeFileSync(path, JSON.stringify({ version: 1, trades: [legacyProtected] })); // pre-anchor v1 state has no anchorBid field
assert.equal(c.load().status, 'incompatible'); // do not silently reinterpret an armed legacy trade without raw anchor provenance
const legacyWithoutTime = { ...legacyProtected, profitFloor: null };
delete legacyWithoutTime.fillTimestampMs;
writeFileSync(path, JSON.stringify({ version: 1, trades: [legacyWithoutTime] }));
assert.equal(c.load().status, 'compatible');
// The raw anchor remains provenance when entry is higher; every saved stage restores unchanged.
const stagedTrade = { ...trade, tradeId: 'staged', executionId: 'staged-buy', entryPrice: 1.23, anchorBid: 1.2, anchorSetAtMs: 2_000, anchorSourceTimestamp: '2026-09-21T13:00:02.000Z', mfeCents: 18, maeCents: 9, exitReason: 'HARD_STOP', reconciling: true };
const stages = [
  { ...stagedTrade, profitFloor: null, sellLatched: false, logicalSellId: null, orderId: null, remainingQty: 1 },
  { ...stagedTrade, profitFloor: 1.28, sellLatched: false, logicalSellId: null, orderId: null, remainingQty: 1 },
  { ...stagedTrade, profitFloor: 1.31, sellLatched: false, logicalSellId: null, orderId: null, remainingQty: 1 },
  { ...stagedTrade, profitFloor: 1.31, sellLatched: true, logicalSellId: 'staged-sell-1', orderId: 'staged-order-1', remainingQty: 0.5 },
];
for (const stage of stages) {
  c.save([stage]);
  const restoredState = c.load();
  assert.equal(restoredState.status, 'compatible');
  assert.deepEqual(restoredState.trades[0], stage);
  const restoredPositions = createPositions({ broker: {} });
  restoredPositions.restoreTrade(restoredState.trades[0]);
  const restoredTrade = restoredPositions.getTrades()[0];
  assert.deepEqual([restoredTrade.anchorBid, restoredTrade.profitFloor, restoredTrade.sellLatched, restoredTrade.logicalSellId, restoredTrade.orderId, restoredTrade.remainingQty], [stage.anchorBid, stage.profitFloor, stage.sellLatched, stage.logicalSellId, stage.orderId, stage.remainingQty]);
  assert.deepEqual([restoredTrade.anchorSetAtMs, restoredTrade.anchorSourceTimestamp], [stage.anchorSetAtMs, stage.anchorSourceTimestamp]);
  assert.deepEqual([restoredTrade.mfeCents, restoredTrade.maeCents, restoredTrade.exitReason, restoredTrade.reconciling], [stage.mfeCents, stage.maeCents, stage.exitReason, stage.reconciling]);
}
c.save([{ ...trade, sellLatched: true, logicalSellId: 'sell-1', orderId: 'o1' }]); // 5. SELL latch/identity survives
assert.equal(c.load().trades[0].logicalSellId, 'sell-1');
c.save([{ ...trade, remainingQty: 0.5 }]); // 6. partial SELL quantity survives
assert.equal(c.load().trades[0].remainingQty, 0.5);
c.clear();
assert.equal(reconcileContinuity({ positions: [{ symbol: trade.symbol, qty: 1 }] }, c.load()).status, 'recovery'); // 7. missing snapshot
writeFileSync(path, '{');
assert.equal(reconcileContinuity({ positions: [{ symbol: trade.symbol, qty: 1 }] }, c.load()).status, 'recovery'); // 8. corrupt snapshot
c.save([trade]);
assert.equal(reconcileContinuity({ positions: [{ symbol: trade.symbol, qty: 2 }] }, c.load()).status, 'recovery');
c.clear();
assert.equal(c.load().status, 'missing'); // 9. confirmed FLAT clears state

const pauseState = { date: '2026-09-23', until: Date.parse('2026-09-23T15:31:00-04:00') };
const setState = { tradeSetId: 'v5-buy-set', date: '2026-09-23', known: true, entryQty: 3, entryCentQty: 300, exitQty: 1, exitCentQty: 98, entryTerminal: true, closedAt: null };
c.save([], { pause: pauseState, sets: [setState] });
assert.deepEqual([c.load().pause, c.load().sets], [pauseState, [setState]]); // same-day runtime data survives while broker flat
c.save([trade]);
assert.deepEqual([c.load().pause, c.load().sets], [pauseState, [setState]]); // position callbacks preserve runtime fields
const dailyLossState = { date: '2026-09-23', dayStartEquity: 10_000, cumulativeRealizedGross: -250, tripped: true, completedBuyIds: ['buy-set-1', 'buy-set-2'] };
c.save([], { pause: pauseState, sets: [setState], dailyLoss: dailyLossState });
assert.deepEqual(c.load().dailyLoss, dailyLossState); // baseline, cumulative result, sticky trip, and dedup IDs survive restart
c.save([trade]);
assert.deepEqual(c.load().dailyLoss, dailyLossState); // position callbacks preserve daily risk state
c.save([], { pause: null, sets: [] });
assert.deepEqual(c.load().dailyLoss, dailyLossState); // unrelated metadata updates preserve daily risk state
c.save([], { pause: null, sets: [], dailyLoss: null });
assert.equal(c.load().status, 'missing');
c.save([], { filledEntryDate: '2026-09-23' });
assert.equal(c.load().filledEntryDate, '2026-09-23', 'one-filled-entry/day marker survives without active trades');
c.save([], { filledEntryDate: null });
assert.equal(c.load().status, 'missing');

const activityRequests = [];
const activityBroker = createAlpacaBroker({ key: 'key', secret: 'secret', baseUrl: 'https://paper-api.alpaca.markets', fetchImpl: async (url, options) => {
  activityRequests.push({ url: new URL(url), options });
  const token = new URL(url).searchParams.get('page_token');
  const rows = token ? [{ id: 'fill-101', activity_type: 'FILL' }] : Array.from({ length: 100 }, (_, index) => ({ id: `fill-${String(index + 1).padStart(3, '0')}`, activity_type: 'FILL' }));
  return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
} });
const activityRows = await activityBroker.getFillActivities({ after: '2026-09-23T13:30:00.000Z' });
assert.equal(activityRows.length, 101);
assert.equal(activityRequests.length, 2, 'FILL activities paginate at 100 rows');
assert.ok(activityRequests.every(({ url, options }) => url.pathname === '/v2/account/activities/FILL' && options.method === undefined));
assert.deepEqual(activityRequests.map(({ url }) => [url.searchParams.get('direction'), url.searchParams.get('page_size'), url.searchParams.get('after')]), [
  ['asc', '100', '2026-09-23T13:30:00.000Z'], ['asc', '100', '2026-09-23T13:30:00.000Z'],
]);
assert.equal(activityRequests[1].url.searchParams.get('page_token'), 'fill-100');
const incompleteActivityBroker = createAlpacaBroker({ key: 'key', secret: 'secret', baseUrl: 'https://paper-api.alpaca.markets', fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ activities: [] }) }) });
await assert.rejects(incompleteActivityBroker.getFillActivities(), /Incomplete account activity page/);

const recoveryPath = join(root, 'recovery.json');
const recoveryContinuity = createContinuity({ path: recoveryPath });
const recoverySymbol = 'SPY260921C00660000';
const recoveryOrders = new Map([['sell-a', { id: 'sell-a', symbol: recoverySymbol, side: 'sell', qty: 1, filled_qty: 0, status: 'new', client_order_id: 'v5-sell-a' }], ['sell-b', { id: 'sell-b', symbol: recoverySymbol, side: 'sell', qty: 1, filled_qty: 0, status: 'new', client_order_id: 'v5-sell-b' }]]);
const recoveryCalls = [];
const recoveryBroker = {
  inspectCurrentState: async () => ({ positions: [{ symbol: recoverySymbol, qty: 3 }], orders: [...recoveryOrders.values()] }),
  replaceOrder: async (id, order) => { recoveryCalls.push(['replace', id]); recoveryOrders.get(id).qty = order.qty; return { id, status: 'accepted' }; },
  submitOrder: async (order) => { const id = `sell-${recoveryCalls.length + 1}`; recoveryCalls.push(['submit', id, order.clientOrderId]); recoveryOrders.set(id, { ...order, id, filled_qty: 0, status: 'new', client_order_id: order.clientOrderId }); return { id, status: 'accepted' }; },
  cancelOrder: async () => {},
};
const recoveryRuntimeArgs = { broker: recoveryBroker, continuity: recoveryContinuity, now: () => Date.parse('2026-09-21T14:00:00Z'), calendar: { sessionFor: () => ({ date: '2026-09-21', status: 'open', open: '2026-09-21T13:30:00Z', close: '2026-09-21T20:00:00Z' }) }, getContracts: async () => [], getQuote: async () => null };
const recoveryRuntime = createRuntime(recoveryRuntimeArgs);
await recoveryRuntime.startup();
recoveryRuntime.onQuote({ symbol: recoverySymbol, bid: 1, ask: 1.01, timestamp: 1 });
await Promise.resolve(); await Promise.resolve();
assert.equal(recoveryCalls.filter(([kind]) => kind === 'replace').length, 2); // two existing V5 SELL identities remain independently owned
assert.equal(recoveryCalls.filter(([kind]) => kind === 'submit').length, 1); // uncovered broker quantity gets one V5 SELL
const recovered = recoveryContinuity.load().trades;
assert.equal(recovered.length, 3);
assert.equal(new Set(recovered.map((trade) => trade.logicalSellId)).size, 3);
recoveryRuntime.stop();
const restartedRecovery = createRuntime(recoveryRuntimeArgs);
await restartedRecovery.startup();
assert.deepEqual(restartedRecovery.getState().state, 'RECOVERING');
assert.deepEqual(recoveryContinuity.load().trades.map((trade) => trade.logicalSellId).sort(), recovered.map((trade) => trade.logicalSellId).sort());
restartedRecovery.stop();
console.log('continuity.check ok');
