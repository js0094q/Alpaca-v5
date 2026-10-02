import assert from 'node:assert/strict';
import { createAlpacaBroker } from './alpaca.mjs';

const baseUrl = 'https://api.alpaca.markets';
const calls = [];
const replies = new Map();
const broker = createAlpacaBroker({ key: 'mock-key', secret: 'mock-secret', baseUrl, mutationTimeoutMs: 20,
  fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    const reply = replies.get(`${options.method ?? 'GET'} ${url}`);
    if (reply instanceof Error) throw reply;
    if (!reply) throw new Error(`Unexpected mocked request: ${options.method ?? 'GET'} ${url}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  } });

const order = { symbol: 'SPY261002C00500000', qty: 1, side: 'sell', limitPrice: 1.23, clientOrderId: 'v5-live-sell-test', positionIntent: 'sell_to_close' };
const encodedId = encodeURIComponent('order / exact-id');
const postUrl = `${baseUrl}/v2/orders`;
const patchUrl = `${baseUrl}/v2/orders/${encodedId}`;
const deleteUrl = patchUrl;

replies.set(`POST ${postUrl}`, { status: 422, body: { code: 42210000, message: 'mock validation rejection' } });
replies.set(`PATCH ${patchUrl}`, { status: 422, body: { code: 42210001, message: 'mock replacement rejection' } });
replies.set(`DELETE ${deleteUrl}`, { status: 422, body: { code: 42210002, message: 'mock cancel rejection' } });

for (const [name, operation, expectedStatus, expectedCode] of [
  ['POST', () => broker.submitOrder(order), 422, 42210000],
  ['PATCH', () => broker.replaceOrder('order / exact-id', { limitPrice: 1.24 }), 422, 42210001],
  ['DELETE', () => broker.cancelOrder('order / exact-id'), 422, 42210002],
]) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.httpStatus, expectedStatus, `${name} preserves HTTP status`);
    assert.equal(error.code, expectedCode, `${name} preserves broker error code`);
    return true;
  });
}

assert.deepEqual(calls.map(({ options }) => options.method), ['POST', 'PATCH', 'DELETE']);
assert.deepEqual(calls.map(({ url }) => url), [postUrl, patchUrl, deleteUrl]);
assert.ok(calls.every(({ url }) => url.startsWith(baseUrl)), 'all LIVE mutations use the LIVE API host');
assert.ok(calls.every(({ options }) => options.signal instanceof AbortSignal), 'each mutation carries a bounded abort signal');
assert.deepEqual(JSON.parse(calls[0].options.body), {
  symbol: order.symbol, qty: order.qty, side: order.side, type: 'limit', limit_price: order.limitPrice,
  time_in_force: 'day', client_order_id: order.clientOrderId, position_intent: order.positionIntent,
});
assert.deepEqual(JSON.parse(calls[1].options.body), { limit_price: 1.24 });

const timeoutCalls = [];
const timeoutBroker = createAlpacaBroker({ key: 'mock-key', secret: 'mock-secret', baseUrl, mutationTimeoutMs: 10,
  fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
    timeoutCalls.push(options);
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }) });
const keepAlive = setInterval(() => {}, 1000);
try {
  for (const operation of [
    () => timeoutBroker.submitOrder(order),
    () => timeoutBroker.replaceOrder('order / exact-id', { limitPrice: 1.24 }),
    () => timeoutBroker.cancelOrder('order / exact-id'),
  ]) await assert.rejects(operation, { name: 'TimeoutError' });
} finally { clearInterval(keepAlive); }
assert.equal(timeoutCalls.length, 3, 'POST, PATCH, and DELETE all time out through their abort signal');

const recoveryCalls = [];
const recoveryBroker = createAlpacaBroker({ key: 'mock-key', secret: 'mock-secret', baseUrl,
  fetchImpl: async (url, options = {}) => {
    recoveryCalls.push({ url, method: options.method ?? 'GET' });
    if (url === `${baseUrl}/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(order.clientOrderId)}`) {
      return new Response(JSON.stringify({ id: 'reconciled-submit', client_order_id: order.clientOrderId }), { status: 200 });
    }
    if (url === `${baseUrl}/v2/orders/${encodedId}`) {
      return new Response(JSON.stringify({ id: 'order / exact-id', status: 'accepted' }), { status: 200 });
    }
    throw new Error(`Unexpected mocked read-back: ${url}`);
  } });

const byClientId = await recoveryBroker.getOrderByClientOrderId(order.clientOrderId);
const byExistingId = await recoveryBroker.getOrder('order / exact-id');
assert.equal(byClientId.client_order_id, order.clientOrderId, 'submit reconciliation queries the exact client ID');
assert.equal(byExistingId.id, 'order / exact-id', 'replace/cancel reconciliation queries the exact existing order ID');
assert.deepEqual(recoveryCalls, [
  { url: `${baseUrl}/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(order.clientOrderId)}`, method: 'GET' },
  { url: `${baseUrl}/v2/orders/${encodedId}`, method: 'GET' },
]);

console.log('mocked LIVE mutation routing, 422, timeout, and exact-ID recovery checks passed');
