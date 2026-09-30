import assert from 'node:assert/strict';
import { createCloseoutBroker } from './closeout.mjs';
import { createRuntime } from './runtime.mjs';
import { createAlpacaProviders as createAlpacaProvidersImpl } from './providers.mjs';
const createAlpacaProviders = (options) => createAlpacaProvidersImpl({ baseUrl: 'https://paper-api.alpaca.markets', ...options });
import { createContinuity } from './continuity.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

const broker = createCloseoutBroker({ key: 'test', secret: 'test' });
await assert.rejects(() => broker.submitOrder({}), /mutation blocked/);
await assert.rejects(() => broker.replaceOrder('id', {}), /mutation blocked/);
await assert.rejects(() => broker.cancelOrder('id'), /mutation blocked/);
assert.deepEqual(broker.mutationAttempts(), ['submit', 'replace', 'cancel']);

const response = (value) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
class LocalSocket {
  static all = [];
  readyState = 1;
  handlers = new Map();
  sent = [];
  constructor(url) { this.url = url; LocalSocket.all.push(this); }
  addEventListener(type, handler) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]); }
  send(value) { this.sent.push(value); }
  close() {}
  emit(type, data) { for (const handler of this.handlers.get(type) ?? []) handler({ data }); }
}
let wall = Date.parse('2026-09-22T13:32:31.000Z');
const replayMethods = [];
const replayBroker = createCloseoutBroker({ key: 'test', secret: 'test', fetchImpl: async (url, options = {}) => { replayMethods.push(options.method ?? 'GET'); return response(url.endsWith('/account') ? { account_number: 'paper' } : []); } });
const calendar = { sessionFor: () => ({ date: '2026-09-22', status: 'open', open: '2026-09-22T13:30:00.000Z', close: '2026-09-22T20:00:00.000Z', cutoff: '2026-09-22T19:30:00.000Z' }) };
const tempDir = await mkdtemp('/tmp/v5-closeout-check-');
let runtime;
const provider = createAlpacaProviders({ key: 'test', secret: 'test', WebSocketImpl: LocalSocket, fetchImpl: async () => response([]) });
const localConnection = provider.connect({ onRawTrade: (trade) => runtime?.onRawTrade(trade) });
runtime = createRuntime({
  broker: replayBroker,
  calendar,
  now: () => wall,
  nowMono: () => wall,
  continuity: createContinuity({ path: join(tempDir, 'active.json') }),
  getContracts: async () => [{ symbol: 'SPY260922C00600000', strike: 600 }],
  getQuote: async () => ({ symbol: 'SPY260922C00600000', bid: 1, ask: 1.01 }),
});
await runtime.start();
wall += 31_000;
const sip = LocalSocket.all.find((socket) => socket.url.endsWith('/v2/sip'));
sip.emit('open');
sip.emit('message', JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
sip.emit('message', JSON.stringify([{ T: 'subscription', trades: ['SPY'] }]));
sip.emit('message', JSON.stringify([{ T: 't', S: 'SPY', p: 600, t: '2026-09-22T13:33:02.000Z', i: 1, x: 'V', z: 'C', c: ['@'] }]));
sip.emit('message', JSON.stringify([{ T: 't', S: 'SPY', p: 601, t: '2026-09-22T13:33:03.000Z', i: 2, x: 'V', z: 'C', c: ['@'] }]));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(replayBroker.mutationAttempts()[0], 'submit');
assert.equal(replayMethods.every((method) => method === 'GET'), true);
runtime.stop();
await rm(tempDir, { recursive: true, force: true });

const normalized = [];
const normalizedProvider = createAlpacaProviders({ key: 'test', secret: 'test', WebSocketImpl: LocalSocket, fetchImpl: async () => response([]) });
const normalizedConnection = normalizedProvider.connect({ onRawTrade: (trade) => normalized.push(trade) });
const normalizedSip = LocalSocket.all.at(-3);
normalizedSip.emit('open');
normalizedSip.emit('message', JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
normalizedSip.emit('message', JSON.stringify([{ T: 'subscription', trades: ['SPY'] }]));
normalizedSip.emit('message', JSON.stringify([{ T: 't', S: 'SPY', p: 600, t: '2026-09-22T13:33:03.000Z', i: 1, x: 'V', z: 'C', c: ['@'] }]));
assert.equal(normalized[0].symbol, 'SPY');
assert.equal(normalized[0].rawType, 't');
normalizedConnection.stop();
