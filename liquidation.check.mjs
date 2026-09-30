import assert from 'node:assert/strict';
import { createRuntime } from './runtime.mjs';

const symbol = 'SPY260922C00773000';
const deadline = Date.parse('2026-09-22T19:59:00.000Z');
let wall = deadline - 1;
const sells = [];
const runtime = createRuntime({
  broker: {
    inspectCurrentState: async () => ({ positions: [{ symbol, qty: 1 }], orders: [] }),
    submitOrder: async (order) => { sells.push(order); return { id: 'sell1', status: 'accepted' }; },
    replaceOrder: async () => ({ id: 'sell1r', status: 'accepted' }),
    cancelOrder: async () => {},
  },
  getContracts: async () => [],
  getQuote: async () => null,
  calendar: { sessionFor: () => ({ date: '2026-09-22', status: 'open', open: '2026-09-22T13:30:00.000Z', close: '2026-09-22T20:00:00.000Z' }) },
  now: () => wall,
  liquidateAt: deadline,
  continuity: {
    load: () => ({ status: 'compatible', trades: [{
      tradeId: 't', executionId: 'e', symbol, entryPrice: 1,
      fillTimestampMs: deadline - 1000, remainingQty: 1, profitFloor: null,
      sellLatched: false, logicalSellId: null, orderId: null,
    }] }),
    save: () => {},
    clear: () => {},
  },
});

try {
  await runtime.start();
  runtime.onQuote({ symbol, bid: 0.89, ask: 0.90, timestamp: new Date(wall).toISOString() });
  runtime.tick();
  assert.equal(sells.length, 0, 'loss remains suppressed before liquidation deadline');
  wall = deadline;
  runtime.tick();
  await new Promise(setImmediate);
  assert.equal(sells.length, 1, 'deadline liquidates even within loss grace');
  runtime.tick();
  await new Promise(setImmediate);
  assert.equal(sells.length, 1, 'already-latched liquidation is not duplicated');
  console.log('liquidation.check: passed');
} finally {
  runtime.stop();
}
