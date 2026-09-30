import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAlpacaBroker as createAlpacaBrokerImpl, normalizeTradeUpdate } from './alpaca.mjs';
const createAlpacaBroker = (options) => createAlpacaBrokerImpl({ baseUrl: 'https://paper-api.alpaca.markets', ...options });
const { createPositions } = await import(process.env.POSITIONS_MODULE || './positions.mjs');
const fixtures = JSON.parse(await readFile(new URL('./regression/sep25-sell-traces.json', import.meta.url)));
const flush = () => new Promise((resolve) => setImmediate(resolve));
const update = (record) => ({ ...record.fields, event: record.fields.orderEvent, timestamp: record.fields.brokerTimestamp });

for (const fixture of fixtures) {
  const [request, response, original, child] = fixture.records;
  for (const timing of ['response-first', 'fill-first', 'stream-first']) {
    const cancels = [], issues = [], exits = [], replacements = [];
    let resolveReplace;
    const p = createPositions({ broker: {
      submitOrder() { assert.fail('must not submit a second SELL'); },
      replaceOrder(id, order) { replacements.push([id, order]); return new Promise((resolve) => { resolveReplace = resolve; }); },
      async cancelOrder(id) { cancels.push(id); }
    }, onExit: (e) => exits.push(e), onExecutionIssue: (e) => issues.push(e) });
    p.restoreTrade({ tradeId: request.fields.tradeId, symbol: request.fields.symbol, entryPrice: 1, remainingQty: 1, profitFloor: 1.05, sellLatched: true, logicalSellId: request.fields.logicalSellId, orderId: request.fields.orderId });
    p.onQuote({ symbol: request.fields.symbol, bid: request.fields.bid });
    if (timing === 'response-first') { resolveReplace({ id: response.fields.orderId, status: response.fields.status }); await flush(); }
    if (timing === 'stream-first') p.onOrderUpdate({ orderId: response.fields.orderId, replaces: request.fields.orderId, event: 'new' });
    p.onOrderUpdate(update(original));
    await flush();
    assert.deepEqual(cancels, [response.fields.orderId], `${fixture.source} ${timing}: cancel child after original closes`);
    assert.equal(p.hasPendingExecution(), true, 'cancel HTTP acceptance does not prove terminal');
    if (timing !== 'response-first') { resolveReplace({ id: response.fields.orderId, status: response.fields.status }); await flush(); }
    assert.deepEqual(cancels, [response.fields.orderId], 'delayed response cannot duplicate cancellation');
    p.onOrderUpdate(update(child));
    p.onOrderUpdate(update(child));
    assert.equal(issues.length, 1, 'actual excess fill must be reported exactly once');
    assert.equal(issues[0].reason, 'SELL_OVERFILL');
    assert.equal(issues[0].excessQty, 1);
    assert.equal(exits.reduce((n, e) => n + e.qty, 0), 1, 'excess cannot inflate valid long exits');
    assert.equal(p.hasPendingExecution(), true, 'overfill requires reconciliation');
    assert.equal(replacements.length, 1);
  }
}

// A replacement unknown until the response still gets canceled after closure.
for (const rejectCancel of [false, true]) {
  let resolveReplace;
  const cancels = [], issues = [];
  const p = createPositions({ broker: {
    replaceOrder: () => new Promise((resolve) => { resolveReplace = resolve; }),
    async cancelOrder(id) { cancels.push(id); if (rejectCancel) throw Object.assign(new Error('cancel failed'), { httpStatus: 422 }); }
  }, onExecutionIssue: (e) => issues.push(e) });
  p.restoreTrade({ tradeId: 'late', symbol: 'SPY', entryPrice: 1, remainingQty: 1, sellLatched: true, logicalSellId: 'sell-late', orderId: 'old' });
  p.onQuote({ symbol: 'SPY', bid: 1.1 });
  p.onOrderUpdate({ orderId: 'old', event: 'fill', executionId: 'one', fillQty: 1, fillPrice: 1.1 });
  assert.equal(p.hasPendingExecution(), true);
  resolveReplace({ id: 'late-child', status: 'new' });
  await flush();
  assert.deepEqual(cancels, ['late-child']);
  assert.equal(p.hasPendingExecution(), true);
  p.onOrderUpdate({ orderId: 'late-child', event: 'canceled' });
  assert.equal(p.hasPendingExecution(), false);
  if (rejectCancel) assert.deepEqual(issues.map((e) => [e.reason, !!e.resolved]), [['SELL_CANCEL_FAILED', false], ['SELL_CANCEL_FAILED', true]]);
}

// Ambiguous PATCH completion cannot release or reprice an unresolved chain.
for (const closeFirst of [true, false]) {
  for (const httpStatus of [undefined, 503, 422]) {
    let rejectReplace;
    let replacements = 0;
    const issues = [], cancels = [];
    const p = createPositions({ broker: {
      replaceOrder() { replacements++; return new Promise((_, reject) => { rejectReplace = reject; }); },
      async cancelOrder(id) { cancels.push(id); }
    }, onExecutionIssue: (e) => issues.push(e) });
    p.restoreTrade({ tradeId: 'unknown', symbol: 'SPY', entryPrice: 1, remainingQty: 1, sellLatched: true, orderId: 'old' });
    p.onQuote({ symbol: 'SPY', bid: 1.1 });
    if (closeFirst) p.onOrderUpdate({ orderId: 'old', event: 'fill', executionId: 'one', fillQty: 1, fillPrice: 1.1 });
    rejectReplace(Object.assign(new Error('PATCH error'), { httpStatus }));
    await flush();
    assert.equal(p.hasPendingExecution(), httpStatus !== 422);
    if (httpStatus === 422) continue;
    p.onQuote({ symbol: 'SPY', bid: 1.09 });
    assert.equal(replacements, 1, 'unknown PATCH cannot launch another request');
    p.onOrderUpdate({ orderId: 'child', replaces: 'old', event: 'new' });
    assert.equal(issues.at(-1).resolved, true);
    if (closeFirst) {
      await flush();
      assert.deepEqual(cancels, ['child']);
      p.onOrderUpdate({ orderId: 'child', event: 'canceled' });
      assert.equal(p.hasPendingExecution(), false);
    } else {
      assert.equal(p.getTrades()[0].orderId, 'child');
    }
  }
}

// Filled HTTP response can precede its execution stream update.
{
  let replacements = 0;
  const p = createPositions({ broker: { async replaceOrder() { replacements++; return { id: 'filled-child', status: 'filled' }; } } });
  p.restoreTrade({ tradeId: 'filled-response', symbol: 'SPY', entryPrice: 1, remainingQty: 1, sellLatched: true, orderId: 'old' });
  p.onQuote({ symbol: 'SPY', bid: 1.1 });
  await flush();
  p.onQuote({ symbol: 'SPY', bid: 1.09 });
  assert.equal(replacements, 1, 'await execution instead of replacing stale parent');
}

const bodies = [];
const broker = createAlpacaBroker({ key: 'test', secret: 'test', fetchImpl: async (_, options) => {
  bodies.push(JSON.parse(options.body));
  return { ok: true, text: async () => JSON.stringify({ id: 'order', status: 'new' }) };
} });
const intentPositions = createPositions({ broker });
intentPositions.onFill({ tradeId: 'intent', executionId: 'intent-buy', symbol: 'SPY260925P00768000', entryPrice: 1, timestamp: 1 });
intentPositions.onQuote({ symbol: 'SPY260925P00768000', bid: 1, timestamp: 10_001 });
intentPositions.onQuote({ symbol: 'SPY260925P00768000', bid: 1.26, timestamp: 10_002 });
await flush();
assert.equal(bodies[0].position_intent, 'sell_to_close');
await broker.replaceOrder('order', { qty: 1, limitPrice: 1.27 });
assert.deepEqual(bodies[1], { limit_price: 1.27 }, 'preserve price-only replacement payload');
assert.equal(normalizeTradeUpdate({ event: 'new', order: { id: 'child', replaces: 'old' } }).replaces, 'old');
console.log('September 25 SELL trace regressions passed');

// Sep25 new-account trace119851–119901: parent fills, replacement is rejected,
// and DELETE child422 must be reconciled from exact-order GETs, not cumulative fills.
for (const evidence of ['inherited-rejected', 'zero-canceled', 'live', 'filled', 'filled-with-activity', 'unknown', 'mismatched-id', 'mismatched-symbol', 'mismatched-side', 'mismatched-lineage', 'unproven-fill', 'get-failed']) {
  const parent = 'b2751b85-dbb0-4f4e-b071-23a7bc23ba3a', child = '5c5a3c50-9cc0-4a1d-ae2c-4b894f35b760';
  const symbol = 'SPY260925C00771000', filledAt = '2026-09-25T19:15:46.216200005Z';
  const exits = [], issues = [], gets = [], cancels = [];
  let replacements = 0;
  const p = createPositions({ broker: {
    async replaceOrder() { replacements++; return { id: child, status: 'new' }; },
    async cancelOrder(id) { cancels.push(id); throw Object.assign(new Error('terminal cannot cancel'), { httpStatus: 422 }); },
    async getOrderFills() { return evidence === 'filled-with-activity' ? [{ order_id: child }] : []; },
    async inspectCurrentState() { return { positions: [], orders: [] }; },
    async getOrder(id) {
      gets.push(id);
      if (evidence === 'get-failed') throw new Error('network');
      if (id === parent) return { id, symbol, side: 'sell', status: 'filled', filled_qty: '1', filled_avg_price: '0.44', filled_at: filledAt };
      return { id: evidence === 'mismatched-id' ? 'wrong' : id, symbol: evidence === 'mismatched-symbol' ? 'OTHER' : symbol, side: evidence === 'mismatched-side' ? 'buy' : 'sell', replaces: evidence === 'mismatched-lineage' ? 'unknown-parent' : parent,
        status: evidence === 'live' ? 'new' : ['filled', 'filled-with-activity'].includes(evidence) ? 'filled' : evidence === 'unknown' ? 'unknown' : evidence === 'zero-canceled' ? 'canceled' : 'rejected',
        filled_qty: evidence === 'zero-canceled' ? '0' : '1', filled_avg_price: '0.44', filled_at: evidence === 'unproven-fill' ? '2026-09-25T19:15:47Z' : filledAt };
    }
  }, onExit: (e) => exits.push(e), onExecutionIssue: (e) => issues.push(e) });
  p.restoreTrade({ tradeId: 'sep25-terminal', symbol, entryPrice: 0.48, remainingQty: 1, sellLatched: true, logicalSellId: 'sell-chain', orderId: parent });
  p.onQuote({ symbol, bid: 0.44 }); await flush();
  p.onOrderUpdate({ orderId: parent, event: 'fill', executionId: 'actual-parent-execution', fillQty: 1, fillPrice: 0.44, timestamp: filledAt, replacedBy: child });
  p.onOrderUpdate({ orderId: parent, event: 'order_replace_rejected', fillQty: 0 });
  assert.equal(p.hasPendingExecution(), true, 'terminal lookup pending still blocks reentry');
  await flush(); await flush();
  const settled = ['inherited-rejected', 'zero-canceled', 'filled'].includes(evidence);
  assert.equal(p.hasPendingExecution(), !settled, `${evidence}: only proven terminal child settles`);
  assert.deepEqual(cancels, [child]); assert.equal(replacements, 1);
  assert.equal(exits.length, 1); assert.equal(exits[0].qty, 1, 'REST cumulative fields are not new executions');
  assert.equal(issues.some((e) => e.reason === 'SELL_CANCEL_FAILED' && !e.resolved), !settled);
  if (settled) {
    assert(gets.includes(child));
    p.onOrderUpdate({ orderId: child, event: 'fill', executionId: 'real-extra-execution', fillQty: 1, fillPrice: 0.44, timestamp: filledAt });
    assert.equal(p.hasPendingExecution(), true, 'real later fill wins over terminal GET');
    assert.equal(issues.at(-1).reason, 'SELL_OVERFILL');
    assert.equal(exits.length, 1, 'real excess does not inflate exits');
  }
}
console.log('September 25 terminal replacement regressions passed');

{
  const requests = [];
  const readBroker = createAlpacaBroker({ key: 'test', secret: 'test', fetchImpl: async (url, options) => {
    requests.push({ url, method: options.method ?? 'GET', bounded: options.signal instanceof AbortSignal });
    return { ok: true, text: async () => JSON.stringify({ id: 'child', status: 'rejected' }) };
  } });
  assert.equal((await readBroker.getOrder('child')).status, 'rejected');
  assert.deepEqual(requests, [{ url: 'https://paper-api.alpaca.markets/v2/orders/child', method: 'GET', bounded: true }]);
}
