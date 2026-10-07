import assert from 'node:assert/strict';
import { createPositions } from './positions.mjs';

export async function demo() {
  const events = [];
  const broker = { async submitOrder() { return { id: 's1', status: 'accepted' }; }, async replaceOrder(id) { return { id, status: 'accepted' }; }, async cancelOrder() {} };
  const p = createPositions({ broker, getDayStartCapital: () => 400, onTelemetry: (e) => events.push(e) });
  p.onFill({ executionId: 'buy', tradeId: 't1', symbol: 'SPY', entryPrice: 2, timestamp: 1 });
  p.onQuote({ symbol: 'SPY', bid: 2.5, ask: 2.51, timestamp: 10_001 });
  p.onQuote({ symbol: 'SPY', bid: 1.01, ask: 1.02, timestamp: 10_002 }); // one cent above the frozen 25% loss threshold
  assert.equal(p.getTrades()[0].sellLatched, false);
  p.onQuote({ symbol: 'SPY', bid: 1, ask: 1.01, timestamp: 10_003 }); // equality latches
  p.onQuote({ symbol: 'SPY', bid: 0, ask: 1.06, timestamp: 10_004 }); // rejected quote: no telemetry
  assert.deepEqual(events.filter((e) => e.type === 'quote').map((e) => e.bid), [2.5, 1.01, 1]);
  const decisions = events.filter((e) => e.type === 'decision');
  assert.deepEqual(decisions.map((e) => e.kind), ['stop_latch']);
  assert.equal(decisions[0].tradeId, 't1');
  assert.equal(decisions[0].bid, 1);
  assert.equal(decisions[0].quoteTimestamp, 10_003);
  assert.ok(!Number.isNaN(Date.parse(decisions[0].at)));

  const silent = createPositions({ broker, onTelemetry: () => { throw new Error('sink down'); } });
  silent.onFill({ executionId: 'buy', tradeId: 't2', symbol: 'QQQ', entryPrice: 1, timestamp: 1 });
  silent.onQuote({ symbol: 'QQQ', bid: 1.5, ask: 1.51, timestamp: 10_001 });
  assert.equal(silent.getTrades()[0].mfeCents, 50); // telemetry failure never touches trading
  console.log('telemetry check passed');
}
if (import.meta.url === `file://${process.argv[1]}`) await demo();
