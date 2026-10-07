import assert from 'node:assert/strict';
import { createPositions } from './positions.mjs';

export async function demo() {
  const orders = [], exits = [];
  const broker = {
    async submitOrder(order) { orders.push(order); return { id: `v5-${orders.length}`, status: 'accepted' }; },
    async replaceOrder(id, order) { orders.push({ id, ...order }); return { id, status: 'accepted' }; },
    async cancelOrder() {}
  };

  const hard = createPositions({ broker, getDayStartCapital: () => 400, onExit: (e) => exits.push(e) });
  hard.onFill({ executionId: 'buy-hard', tradeId: 'hard', symbol: 'OCC-HARD', entryPrice: 2, contractSize: 100, timestamp: 1 });
  hard.onQuote({ symbol: 'OCC-HARD', bid: 2.5, timestamp: 2 });
  hard.onQuote({ symbol: 'OCC-HARD', bid: 1.01, timestamp: 3 });
  assert.equal(hard.getTrades()[0].sellLatched, false, 'one cent above the capital-scaled stop holds');
  hard.onQuote({ symbol: 'OCC-HARD', bid: 1, timestamp: 4 });
  hard.onQuote({ symbol: 'OCC-HARD', bid: 0.90, timestamp: 5 });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(hard.getTrades()[0].exitReason, 'HARD_STOP');
  assert.deepEqual([hard.getTrades()[0].mfeCents, hard.getTrades()[0].maeCents], [50, 110]);
  assert.equal(orders.filter((order) => !order.id).length, 1, 'hard stop latches once; later bids may reprice the persistent SELL');
  hard.onOrderUpdate({ orderId: 'v5-1', executionId: 'hard-sell', fillQty: 1, fillPrice: 1, timestamp: 6 });
  assert.deepEqual([exits[0].exitReason, exits[0].mfeCents, exits[0].maeCents], ['HARD_STOP', 50, 110]);

  const manualExits = [];
  const manual = createPositions({ broker, onExit: (e) => manualExits.push(e), getDayStartCapital: () => 4 });
  const beforeManual = orders.length;
  manual.onFill({ executionId: 'buy-manual', tradeId: 'manual', symbol: 'OCC-MANUAL', entryPrice: 1.20, contractSize: 100, timestamp: 1 });
  manual.setExternalSell('OCC-MANUAL', true);
  manual.onQuote({ symbol: 'OCC-MANUAL', bid: 0.01, timestamp: 2 });
  await Promise.resolve();
  assert.equal(orders.length, beforeManual, 'an open manual SELL suppresses V5 submission');
  manual.setExternalSell('OCC-MANUAL', false);
  manual.onQuote({ symbol: 'OCC-MANUAL', bid: 0.89, timestamp: 3 });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(orders.length, beforeManual + 1, 'V5 may resume after the manual order is gone');

  const adopted = createPositions({ broker, onExit: (e) => manualExits.push(e) });
  adopted.onFill({ executionId: 'buy-ext', tradeId: 'external', symbol: 'OCC-EXT', entryPrice: 1.25, contractSize: 100, timestamp: 10 });
  const result = adopted.adoptExternalFill({ tradeId: 'external', executionId: 'manual-fill', symbol: 'OCC-EXT', fillQty: 1, fillPrice: 1.40, timestamp: '2026-10-07T14:00:00Z', orderId: 'manual-order' });
  assert.equal(result.adopted, true);
  assert.deepEqual([manualExits[0].actionSource, manualExits[0].exitReason, manualExits[0].realizedPnlUsd], ['EXTERNAL_MANUAL_EXIT', 'EXTERNAL_MANUAL_EXIT', 15]);
  assert.equal(adopted.getTrades()[0].remainingQty, 0);

  const partialSell = createPositions({ broker, onExit: (e) => manualExits.push(e) });
  partialSell.onFill({ executionId: 'buy-v5-partial', tradeId: 'v5-partial', symbol: 'OCC-V5-PARTIAL', entryPrice: 1, timestamp: 1 });
  partialSell.liquidate();
  partialSell.onQuote({ symbol: 'OCC-V5-PARTIAL', bid: 1, timestamp: 2 });
  await Promise.resolve(); await Promise.resolve();
  const partialOrder = orders.at(-1);
  partialSell.onOrderUpdate({ orderId: partialOrder.id ?? 'v5-4', executionId: 'part-fill', fillQty: 0.5, fillPrice: 1.1, timestamp: 3 });
  partialSell.onOrderUpdate({ orderId: partialOrder.id ?? 'v5-4', executionId: 'part-fill', fillQty: 0.5, fillPrice: 1.1, timestamp: 4 });
  assert.equal(partialSell.getTrades()[0].remainingQty, 0.5, 'duplicate V5 fill execution is accounted once');

  const partial = createPositions({ broker, onExit: (e) => manualExits.push(e) });
  partial.onFill({ executionId: 'buy-partial', tradeId: 'partial', symbol: 'OCC-PARTIAL', entryPrice: 1, timestamp: 1 });
  partial.setExternalSell('OCC-PARTIAL', true);
  assert.equal(partial.adoptExternalFill({ tradeId: 'partial', executionId: 'bad-fill', symbol: 'OCC-PARTIAL', fillQty: 0.5, fillPrice: 1.1, timestamp: 2 }).adopted, false);
  assert.equal(partial.getTrades()[0].remainingQty, 1, 'unmatched manual evidence keeps the trade in reconciliation');
  return true;
}
if (import.meta.url === `file://${process.argv[1]}`) await demo();
