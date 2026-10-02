import assert from 'node:assert/strict';
import { createPositions } from './positions.mjs';
export async function demo() {
  const calls = [], exits = [];
  const broker = { async submitOrder(r) { calls.push(['submit', r]); return { id: `s${calls.length}`, status: 'accepted' }; }, async replaceOrder(id, r) { calls.push(['replace', id, r]); return { id: `${id}r`, status: 'accepted' }; }, async cancelOrder() {} };
  const p = createPositions({ broker, onExit: (e) => exits.push(e) });
  for (const id of ['a', 'b', 'c']) p.onFill({ executionId: 'buy-1', tradeId: id, symbol: 'SPY', entryPrice: 1, timestamp: 1 });
  p.onQuote({ symbol: 'SPY', bid: 1, ask: 1.01, timestamp: 10_001 }); // shared T+10 anchor
  assert.deepEqual(p.getTrades().map((t) => t.anchorBid), [1, 1, 1]);
  p.onQuote({ symbol: 'SPY', bid: 1.02, ask: 1.03, timestamp: 10_002 }); assert.deepEqual(p.getTrades().map((t) => t.profitFloor), [0.98, 0.98, 0.98]);
  p.onQuote({ symbol: 'SPY', bid: 1.15, ask: 1.16, timestamp: 10_003 }); assert.deepEqual(p.getTrades().map((t) => t.profitFloor), [1.11, 1.11, 1.11]);
  p.onQuote({ symbol: 'SPY', bid: 1.11, ask: 1.12, timestamp: 10_004 });
  p.onQuote({ symbol: 'SPY', bid: 1.10, ask: 1.11, timestamp: 10_005 });
  await Promise.resolve(); await Promise.resolve(); assert.equal(calls.length, 3);
  p.onQuote({ symbol: 'SPY', bid: 1.10, ask: 1.11, timestamp: 10_006 });
  await Promise.resolve(); assert.equal(calls.length, 3);
  p.onOrderUpdate({ orderId: 's1', executionId: 'sell-a', fillQty: 0.5, fillPrice: 1.07, timestamp: 5 }); p.onOrderUpdate({ orderId: 's1', executionId: 'sell-a', fillQty: 0.5, fillPrice: 1.07, timestamp: 6 }); assert.equal(exits.length, 1); assert.equal(p.getTrades()[0].remainingQty, 0.5);
  p.onQuote({ symbol: 'SPY', bid: 1.10, ask: 1.11, timestamp: 10_007 });
  p.onFill({ executionId: 'buy-1', tradeId: 'e', symbol: 'QQQ', entryPrice: 1, timestamp: 8 });
  p.onQuote({ symbol: 'QQQ', bid: 1, ask: 1.01, timestamp: 10_008 });
  p.onQuote({ symbol: 'QQQ', bid: 0.90, ask: 0.91, timestamp: 10_009 });
  await Promise.resolve();
  assert.equal(p.getTrades().find((t) => t.tradeId === 'e').sellLatched, true);
  p.onFill({ executionId: 'buy-1', tradeId: 'f', symbol: 'QQQ', entryPrice: 1, timestamp: 8 });
  assert.equal(p.getTrades().find((t) => t.tradeId === 'f').sellLatched, true);
  await Promise.resolve();
  const before = calls.length; p.onQuote({ symbol: 'SPY', bid: 1.10, ask: 1.11, timestamp: 10_007 }); await Promise.resolve(); assert.equal(calls.length, before);
  p.onFill({ executionId: 'buy-1', tradeId: 'd', symbol: 'SPY', entryPrice: 1, timestamp: -9_999 }); p.onQuote({ symbol: 'SPY', bid: 1.20, ask: 1.21, timestamp: 10_010 }); p.onQuote({ symbol: 'SPY', bid: 1.15, ask: 1.16, timestamp: 10_011 });
  const d = p.getTrades().find((t) => t.tradeId === 'd'); p.onOrderUpdate({ orderId: 'preack', clientOrderId: d.logicalSellId, executionId: 'sell-d', fillQty: 1, fillPrice: 1.10, timestamp: 11 }); assert.equal(p.getTrades().find((t) => t.tradeId === 'd').remainingQty, 0);

  let wall = Date.parse('2026-09-22T14:00:00.000Z');
  const grace = createPositions({ broker, now: () => wall });
  grace.onFill({ executionId: 'buy-grace', tradeId: 'g1', symbol: 'GRACE', entryPrice: 1, timestamp: '2026-09-22T14:00:00.000123Z' });
  wall = Date.parse('2026-09-22T14:00:05.000Z');
  grace.onQuote({ symbol: 'GRACE', bid: 0.89, ask: 0.90, timestamp: '2026-09-22T14:00:05Z' });
  assert.equal(grace.getTrades()[0].sellLatched, false);
  wall = Date.parse('2026-09-22T14:00:08Z');
  grace.onFill({ executionId: 'buy-grace', tradeId: 'g2', symbol: 'GRACE', entryPrice: 1, timestamp: '2026-09-22T14:00:08Z' });
  const g1StateBeforeLoss = grace.getTrades().find((t) => t.tradeId === 'g1');
  wall = Date.parse('2026-09-22T14:00:10.000Z');
  grace.onQuote({ symbol: 'GRACE', bid: 0.89, ask: 0.90, timestamp: '2026-09-22T14:00:10Z' });
  assert.equal(grace.getTrades().find((t) => t.tradeId === 'g1').sellLatched, false); // sub-ms fill is not eligible early
  assert.equal(grace.getTrades().find((t) => t.tradeId === 'g2').sellLatched, false); // independent fill timer
  wall = Date.parse('2026-09-22T14:00:10.001Z');
  grace.onQuote({ symbol: 'GRACE', bid: 0.89, ask: 0.90, timestamp: '2026-09-22T14:00:10.001Z' });
  assert.equal(grace.getTrades().find((t) => t.tradeId === 'g1').sellLatched, true);
  assert.equal(grace.getTrades().find((t) => t.tradeId === 'g2').sellLatched, false);
  wall = Date.parse('2026-09-22T14:00:18.000Z');
  grace.onQuote({ symbol: 'GRACE', bid: 0.89, ask: 0.90, timestamp: '2026-09-22T14:00:18Z' });
  assert.equal(grace.getTrades().find((t) => t.tradeId === 'g2').sellLatched, true);
  let restoredWall = Date.parse('2026-09-22T14:00:10.000Z');
  const restored = createPositions({ broker, now: () => restoredWall });
  restored.restoreTrade(g1StateBeforeLoss);
  restored.onQuote({ symbol: 'GRACE', bid: 0.89, ask: 0.90, timestamp: '2026-09-22T14:00:10Z' });
  assert.equal(restored.getTrades()[0].sellLatched, false); // restored fill time keeps the grace boundary
  restoredWall = Date.parse('2026-09-22T14:00:10.001Z');
  restored.onQuote({ symbol: 'GRACE', bid: 0.89, ask: 0.90, timestamp: '2026-09-22T14:00:10.001Z' });
  assert.equal(restored.getTrades()[0].sellLatched, true);

  let exactNow = 19_999;
  const exact = createPositions({ broker, now: () => exactNow });
  exact.onFill({ executionId: 'buy-exact', tradeId: 'x1', symbol: 'EXACT', entryPrice: 1, timestamp: 10_000 });
  exact.onQuote({ symbol: 'EXACT', bid: 0.89, ask: 0.90, timestamp: 20_000 }); // source time cannot bypass receipt grace
  assert.equal(exact.getTrades()[0].sellLatched, false);
  exactNow = 20_000;
  exact.onQuote({ symbol: 'EXACT', bid: 0.89, ask: 0.90, timestamp: 10_000 }); // stale source time does not block an accepted T+10 bid
  assert.equal(exact.getTrades()[0].sellLatched, true);

  let profitNow = Date.parse('2026-09-22T15:00:05Z');
  const profit = createPositions({ broker, now: () => profitNow });
  profit.onFill({ executionId: 'buy-profit', tradeId: 'p1', symbol: 'PROFIT', entryPrice: 1, timestamp: '2026-09-22T15:00:00Z' });
  for (const timestamp of ['2026-09-22T15:00:05Z', '2026-09-22T15:00:09.999999Z', undefined]) {
    profit.onQuote({ symbol: 'PROFIT', bid: 1.20, ask: 1.21, timestamp });
    assert.deepEqual([profit.getTrades()[0].anchorBid, profit.getTrades()[0].profitFloor, profit.getTrades()[0].sellLatched], [null, null, false], 'ordinary rules wait through receipt-time T+10');
  }
  profitNow = Date.parse('2026-09-22T15:00:10Z');
  profit.onQuote({ symbol: 'PROFIT', bid: 1, ask: 1.01, timestamp: '2026-09-22T15:00:09Z' }); // accepted exactly T+10 despite earlier source time
  assert.equal(profit.getTrades()[0].anchorBid, 1);
  profitNow += 1;
  profit.onQuote({ symbol: 'PROFIT', bid: 1.02, ask: 1.03, timestamp: '2026-09-22T15:00:11Z' });
  assert.equal(profit.getTrades()[0].profitFloor, 0.98);
  profit.onQuote({ symbol: 'PROFIT', bid: 1.05, ask: 1.06, timestamp: '2026-09-22T15:00:12Z' });
  assert.equal(profit.getTrades()[0].profitFloor, 1.01);
  assert.equal(profit.getTrades()[0].sellLatched, false);
  profit.onQuote({ symbol: 'PROFIT', bid: 1.01, ask: 1.02, timestamp: '2026-09-22T15:00:13Z' });
  assert.equal(profit.getTrades()[0].sellLatched, false); // equality holds
  profit.onQuote({ symbol: 'PROFIT', bid: 1.00, ask: 1.01, timestamp: '2026-09-22T15:00:14Z' });
  assert.equal(profit.getTrades()[0].sellLatched, true);

  const clamped = createPositions({ broker });
  clamped.onFill({ executionId: 'buy-clamped', tradeId: 'clamp-lot', symbol: 'CLAMP', entryPrice: 1, timestamp: 1_000 });
  clamped.onQuote({ symbol: 'CLAMP', bid: 0.90, ask: 0.91, timestamp: 11_000 });
  assert.deepEqual([clamped.getTrades()[0].anchorBid, clamped.getTrades()[0].sellLatched], [0.90, true]); // entry $1 / anchor $0.90 keeps the $0.90 floor

  const aboveEntry = createPositions({ broker });
  aboveEntry.onFill({ executionId: 'buy-above', tradeId: 'above-lot', symbol: 'ABOVE', entryPrice: 1, timestamp: 1_000 });
  aboveEntry.onQuote({ symbol: 'ABOVE', bid: 1.10, ask: 1.11, timestamp: 11_000 });
  assert.deepEqual([aboveEntry.getTrades()[0].anchorBid, aboveEntry.getTrades()[0].profitFloor, aboveEntry.getTrades()[0].sellLatched], [1.1, null, false]); // anchor quote cannot arm profit
  aboveEntry.onQuote({ symbol: 'ABOVE', bid: 1, ask: 1.01, timestamp: 11_001 });
  assert.equal(aboveEntry.getTrades()[0].sellLatched, false); // strong anchor floor is 0.99
  aboveEntry.onQuote({ symbol: 'ABOVE', bid: 0.99, ask: 1, timestamp: 11_002 });
  assert.equal(aboveEntry.getTrades()[0].sellLatched, true); // 90% anchor raises the protected floor to $0.99

  // Raw anchor provenance is retained; the effective reference drives trail arming.
  for (const [tradeId, rawAnchor, reference, arm] of [
    ['below-entry', 0.95, 1.00, 1.02],
    ['at-entry', 1.00, 1.00, 1.02],
    ['above-entry', 1.20, 1.20, 1.22]
  ]) {
    let now = 20_000;
    const referenceLot = createPositions({ broker, now: () => now });
    referenceLot.onFill({ executionId: `buy-${tradeId}`, tradeId, symbol: 'REFERENCE', entryPrice: 1, timestamp: 10_000 });
    referenceLot.onQuote({ symbol: 'REFERENCE', bid: rawAnchor, ask: rawAnchor + 0.01, timestamp: `raw-${tradeId}` });
    let trade = referenceLot.getTrades()[0];
    assert.deepEqual([trade.anchorBid, trade.sellLatched], [rawAnchor, false], `${tradeId}: raw anchor remains visible`);

    if (tradeId === 'below-entry') {
      now += 1;
      referenceLot.onQuote({ symbol: 'REFERENCE', bid: 1.00, ask: 1.01, timestamp: 'raw-anchor-plus-5c' });
      assert.equal(referenceLot.getTrades()[0].profitFloor, null, 'raw anchor cannot arm below effective reference +2c');
    }

    now += 1;
    referenceLot.onQuote({ symbol: 'REFERENCE', bid: arm, ask: arm + 0.01, timestamp: 'arm' });
    trade = referenceLot.getTrades()[0];
    assert.deepEqual([trade.anchorBid, trade.profitFloor, trade.sellLatched], [rawAnchor, arm - 0.04, false], `${tradeId}: arm uses actual bid and preserves raw anchor`);
  }

  const anchorLoss = createPositions({ broker });
  anchorLoss.onFill({ executionId: 'buy-anchor-loss', tradeId: 'anchor-loss', symbol: 'ANCHOR-LOSS', entryPrice: 1, timestamp: 1_000 });
  anchorLoss.onQuote({ symbol: 'ANCHOR-LOSS', bid: 0.90, ask: 0.91, timestamp: 'anchor-loss-equality' });
  assert.deepEqual([anchorLoss.getTrades()[0].anchorBid, anchorLoss.getTrades()[0].sellLatched], [0.90, true], 'loss equality is evaluated on the anchor quote');

  let shiftedNow = 10_999;
  const shifted = createPositions({ broker, now: () => shiftedNow });
  shifted.onFill({ executionId: 'buy-shifted', tradeId: 'shifted', symbol: 'SHIFT', entryPrice: 1, timestamp: 1_000 });
  shifted.onQuote({ symbol: 'SHIFT', bid: 1.10, ask: 1.11, timestamp: 50_000 });
  assert.equal(shifted.getTrades()[0].anchorBid, null, 'pre-T+10 receipt cannot be bypassed by a future source timestamp');
  shiftedNow = 11_000;
  shifted.onQuote({ symbol: 'SHIFT', bid: 1.20, ask: 1.21, timestamp: 9_000 });
  shifted.onFill({ executionId: 'buy-shifted', tradeId: 'shifted', symbol: 'SHIFT', entryPrice: 1, timestamp: 1_000 });
  for (const [bid, floor, latched] of [[1.25, 1.21, false], [1.28, 1.24, false], [1.28, 1.24, false], [1.30, 1.26, false], [1.25, 1.26, true]]) {
    shiftedNow += 1;
    shifted.onQuote({ symbol: 'SHIFT', bid, ask: bid + 0.01, timestamp: 13_000 });
    assert.deepEqual([shifted.getTrades()[0].anchorBid, shifted.getTrades()[0].profitFloor, shifted.getTrades()[0].sellLatched], [1.20, floor, latched], 'later quotes and duplicate fills preserve the original anchor and shifted profit thresholds');
  }

  let cachedNow = 10_999;
  const cached = createPositions({ broker, now: () => cachedNow });
  cached.onQuote({ symbol: 'CACHED', bid: 1.50, ask: 1.51, timestamp: 20_000 });
  cached.onFill({ executionId: 'buy-cached', tradeId: 'cached', symbol: 'CACHED', entryPrice: 1, timestamp: 1_000 });
  assert.equal(cached.getTrades()[0].anchorBid, null, 'a cached pre-T+10 quote cannot seed a later fill');
  cachedNow = 11_000;
  cached.onQuote({ symbol: 'CACHED', bid: 1.10, ask: 1.11, timestamp: 1 });
  assert.equal(cached.getTrades()[0].anchorBid, 1.1, 'the next usable quote accepted at T+10 becomes the anchor');

  let independentNow = 1_000;
  const independent = createPositions({ broker, now: () => independentNow });
  independent.onFill({ executionId: 'buy-i1', tradeId: 'i1', symbol: 'INDEPENDENT', entryPrice: 1, timestamp: 1_000 });
  independentNow = 6_000;
  independent.onFill({ executionId: 'buy-i2', tradeId: 'i2', symbol: 'INDEPENDENT', entryPrice: 1, timestamp: 6_000 });
  independentNow = 11_000;
  independent.onQuote({ symbol: 'INDEPENDENT', bid: 1, ask: 1.01, timestamp: 1 });
  assert.deepEqual(independent.getTrades().map((trade) => trade.anchorBid), [1, null]);
  independentNow = 16_000;
  independent.onQuote({ symbol: 'INDEPENDENT', bid: 1.10, ask: 1.11, timestamp: 1 });
  assert.deepEqual(independent.getTrades().map((trade) => [trade.anchorBid, trade.sellLatched]), [[1, false], [1.1, false]]); // +10c is no longer a ceiling

  const legacyRestore = createPositions({ broker, now: () => 11_000 });
  legacyRestore.restoreTrade({ tradeId: 'legacy', executionId: 'legacy-buy', symbol: 'LEGACY', entryPrice: 1, fillTimestampMs: 1_000, remainingQty: 1, profitFloor: 1.05, sellLatched: false, logicalSellId: null, orderId: null });
  assert.deepEqual([legacyRestore.getTrades()[0].anchorBid, legacyRestore.getTrades()[0].profitFloor], [null, null]);
  legacyRestore.onQuote({ symbol: 'LEGACY', bid: 1, ask: 1.01, timestamp: 1 });
  assert.deepEqual([legacyRestore.getTrades()[0].anchorBid, legacyRestore.getTrades()[0].profitFloor], [1, null]);

  for (const steps of [
    [[1.02, false], [1.01, false], [0.97, true]],
    [[1.06, false], [1.15, false], [1.11, false], [1.10, true]],
    [[1.50, false], [1.40, true]]
  ]) {
    const orders = [];
    const ladder = createPositions({
      broker: {
        async submitOrder(order) { orders.push(order); return { id: 'ladder-sell', status: 'accepted' }; },
        async replaceOrder(id, order) { orders.push({ operation: 'replace', ...order }); return { id, status: 'accepted' }; }
      },
      now: () => 10_001
    });
    ladder.onFill({ executionId: 'ladder-buy', tradeId: 'ladder-lot', symbol: 'LADDER', entryPrice: 1, timestamp: 1 });
    ladder.onQuote({ symbol: 'LADDER', bid: 1, ask: 1.01, timestamp: 10_001 });
    for (const [index, [bid, shouldLatch]] of steps.entries()) {
      ladder.onQuote({ symbol: 'LADDER', bid, ask: bid + 0.01, timestamp: index + 10_002 });
      assert.equal(ladder.getTrades()[0].sellLatched, shouldLatch, `bid ${bid}: latch state follows the current floor`);
      assert.equal(orders.length, shouldLatch ? 1 : 0, `bid ${bid}: only a latch submits a SELL`);
      if (shouldLatch) {
        assert.equal(orders[0].side, 'sell');
        assert.equal(orders[0].limitPrice, bid);
      }
    }
    await Promise.resolve();
    assert.equal(orders.length, 1);
  }

  const gappedArm = createPositions({ broker, now: () => 10_001 });
  gappedArm.onFill({ executionId: 'gap-buy', tradeId: 'gap-lot', symbol: 'GAP', entryPrice: 1, timestamp: 1 });
  gappedArm.onQuote({ symbol: 'GAP', bid: 1, ask: 1.01, timestamp: 10_001 });
  gappedArm.onQuote({ symbol: 'GAP', bid: 1.07, ask: 1.08, timestamp: 10_002 });
  assert.deepEqual([gappedArm.getTrades()[0].profitFloor, gappedArm.getTrades()[0].sellLatched], [1.03, false], 'a gapped arm uses the actual arming bid minus four cents');
  gappedArm.onQuote({ symbol: 'GAP', bid: 1.03, ask: 1.04, timestamp: 10_003 });
  assert.equal(gappedArm.getTrades()[0].sellLatched, false, 'equality at the gapped-arm floor holds');
  gappedArm.onQuote({ symbol: 'GAP', bid: 1.02, ask: 1.03, timestamp: 10_004 });
  assert.equal(gappedArm.getTrades()[0].sellLatched, true, 'one cent below the gapped-arm floor latches');
  return true;
}
if (import.meta.url === `file://${process.argv[1]}`) await demo();
