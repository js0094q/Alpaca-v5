import assert from 'node:assert/strict';
import { createPositions } from './positions.mjs';
export async function demo() {
  const events = [];
  const broker = { async submitOrder() { return { id: 's1', status: 'accepted' }; }, async replaceOrder(id) { return { id, status: 'accepted' }; }, async cancelOrder() {} };
  const p = createPositions({ broker, onTelemetry: (e) => events.push(e) });
  p.onFill({ executionId: 'buy', tradeId: 't1', symbol: 'SPY', entryPrice: 1, timestamp: 1 });
  p.onQuote({ symbol: 'SPY', bid: 1, ask: 1.01, timestamp: 10_001 }); // anchor after grace
  p.onQuote({ symbol: 'SPY', bid: 1.02, ask: 1.03, timestamp: 10_002 }); // floor set 0.98
  p.onQuote({ symbol: 'SPY', bid: 1.10, ask: 1.11, timestamp: 10_003 }); // floor raise 1.06
  p.onQuote({ symbol: 'SPY', bid: 1.05, ask: 1.06, timestamp: 10_004 }); // floor latch
  p.onQuote({ symbol: 'SPY', bid: 0, ask: 1.06, timestamp: 10_005 }); // rejected quote: no telemetry
  assert.deepEqual(events.filter((e) => e.type === 'quote').map((e) => e.bid), [1, 1.02, 1.1, 1.05]);
  assert.deepEqual(events.filter((e) => e.type === 'decision').map((e) => e.kind), ['anchor_set', 'floor_set', 'floor_raise', 'floor_latch']);
  const latch = events.at(-1);
  assert.equal(latch.tradeId, 't1'); assert.equal(latch.bid, 1.05); assert.equal(latch.profitFloor, 1.06); assert.equal(latch.anchorBid, 1); assert.equal(latch.quoteTimestamp, 10_004);
  assert.ok(!Number.isNaN(Date.parse(latch.at)));
  const q = createPositions({ broker, onTelemetry: (e) => events.push(e) });
  q.onFill({ executionId: 'buy', tradeId: 't2', symbol: 'QQQ', entryPrice: 1, timestamp: 1 });
  q.onQuote({ symbol: 'QQQ', bid: 1, ask: 1.01, timestamp: 10_001 });
  q.onQuote({ symbol: 'QQQ', bid: 0.9, ask: 0.91, timestamp: 10_002 });
  assert.equal(events.at(-1).kind, 'stop_latch');
  const silent = createPositions({ broker, onTelemetry: () => { throw new Error('sink down'); } });
  silent.onFill({ executionId: 'buy', tradeId: 't3', symbol: 'IWM', entryPrice: 1, timestamp: 1 });
  silent.onQuote({ symbol: 'IWM', bid: 1, ask: 1.01, timestamp: 10_001 });
  assert.equal(silent.getTrades()[0].anchorBid, 1); // telemetry failure never touches trading
  console.log('telemetry check passed');
}
if (import.meta.url === `file://${process.argv[1]}`) await demo();
