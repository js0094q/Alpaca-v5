import assert from 'node:assert/strict';
import { decode, encode } from '@msgpack/msgpack';
import { createAlpacaProviders } from './providers.mjs';

const requests = [];
const requestOptions = [];
const fetchImpl = async (url, options) => {
  requests.push(url);
  requestOptions.push(options);
  const body = url.includes('/calendar')
    ? [{ date: '2026-09-21', open: '09:30', close: '16:00' }]
    : url.includes('/contracts')
      ? (url.includes('page_token=next')
        ? { option_contracts: [{ symbol: 'SPY260921C00601000', strike_price: '601' }], next_page_token: null }
        : { option_contracts: [{ symbol: 'SPY260921C00600000', strike_price: '600', size: '100' }], next_page_token: 'next' })
      : { quotes: { SPY260921C00600000: { bp: 1.2, ap: 1.25, t: '2026-09-21T13:31:00Z' } } };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

class MockSocket {
  static sockets = [];
  readyState = 1;
  sent = [];
  handlers = new Map();
  pings = 0;
  constructor(url) { this.url = url; MockSocket.sockets.push(this); }
  addEventListener(type, handler) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]); }
  on(type, handler) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]); }
  send(value) { this.sent.push(value); }
  ping() { this.pings++; }
  close() { this.closed = true; this.readyState = 3; }
  terminate() { this.terminated = true; this.close(); }
  emit(type, data) { for (const handler of this.handlers.get(type) ?? []) handler(type === 'message' ? { data } : data); }
}

const providers = createAlpacaProviders({ key: 'key', secret: 'secret', baseUrl: 'https://paper-api.alpaca.markets', fetchImpl, WebSocketImpl: MockSocket });
const nativeAbortTimeout = AbortSignal.timeout;
const timeoutValues = [];
AbortSignal.timeout = (ms) => { timeoutValues.push(ms); return nativeAbortTimeout.call(AbortSignal, ms); };
const contracts = await providers.getContracts('CALL', '2026-09-21T13:31:00Z');
assert.deepEqual(contracts, [{ symbol: 'SPY260921C00600000', strike: 600, contractSize: 100 }, { symbol: 'SPY260921C00601000', strike: 601 }]);
const contractRequestCount = requests.length;
assert.deepEqual(await providers.getContracts('CALL', '2026-09-21T13:31:00Z'), contracts, 'successful same-day contract result is cached');
assert.equal(requests.length, contractRequestCount, 'cache avoids another paginated chain read');
assert.ok(requests.every((url) => !url.includes('/v1/options/contracts')));
assert.ok(requests.some((url) => url.includes('/v2/options/contracts')));
assert.deepEqual(await providers.getQuote(contracts[0].symbol), { symbol: contracts[0].symbol, bid: 1.2, ask: 1.25, timestamp: '2026-09-21T13:31:00Z' });
await providers.calendar.loadCalendar({ start: '2026-09-21', end: '2026-09-21' });
assert.equal(providers.calendar.sessionFor('2026-09-21T14:00:00Z').status, 'open');
assert.equal(providers.calendar.sessionFor('2026-09-21T14:00:00Z').date, '2026-09-21');
assert.ok(timeoutValues.length >= 4 && timeoutValues.every((ms) => ms === 5_000), 'all REST reads receive the fixed five-second timeout');
assert.ok(requestOptions.every(({ signal, redirect }) => signal instanceof AbortSignal && redirect === 'error'), 'REST reads use abort signals and reject redirects');
AbortSignal.timeout = nativeAbortTimeout;

const rawTrades = [];
const quotes = [];
const updates = [];
const statuses = [];
const disconnects = [];
const connection = providers.connect({ onRawTrade: (value) => rawTrades.push(value), onQuote: (value) => quotes.push(value), onTradeUpdate: (value) => updates.push(value), onStatus: (value) => statuses.push(value), onDisconnect: (value) => disconnects.push(value), optionSymbols: [contracts[0].symbol] });
const sip = MockSocket.sockets.find(({ url }) => url.endsWith('/v2/sip'));
const opra = MockSocket.sockets.find(({ url }) => url.includes('/opra'));
const trade = MockSocket.sockets.find(({ url }) => url.endsWith('/stream'));
const wireJson = (socket) => socket.sent.map((value) => typeof value === 'string' ? JSON.parse(value) : decode(value));
sip.emit('open');
opra.emit('open');
trade.emit('open');
assert.deepEqual(wireJson(sip)[0], { action: 'auth', key: 'key', secret: 'secret' });
assert.deepEqual(wireJson(opra)[0], { action: 'auth', key: 'key', secret: 'secret' });
assert.deepEqual(wireJson(trade)[0], { action: 'auth', key: 'key', secret: 'secret' });
sip.emit('message', JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
opra.emit('message', encode([{ T: 'success', msg: 'authenticated' }]));
trade.emit('message', new TextEncoder().encode(JSON.stringify({ stream: 'authorization', data: { status: 'authorized' } })));
assert.deepEqual(wireJson(sip)[1], { action: 'subscribe', trades: ['SPY'] });
assert.deepEqual(wireJson(opra)[1], { action: 'subscribe', quotes: [contracts[0].symbol] });
assert.deepEqual(wireJson(trade)[1], { action: 'listen', data: { streams: ['trade_updates'] } });
sip.emit('message', JSON.stringify([{ T: 'subscription', trades: ['SPY'] }]));
opra.emit('message', encode([{ T: 'subscription', quotes: [contracts[0].symbol] }]));
trade.emit('message', JSON.stringify({ stream: 'listening', data: { streams: ['trade_updates'] } }));
sip.emit('message', JSON.stringify([{ T: 'c', S: 'SPY', t: '2026-09-21T14:00:00Z', i: 7, x: 'V', z: 'C' }]));
sip.emit('message', JSON.stringify([{ T: 't', S: 'SPY', p: 600, t: '2026-09-21T14:00:01Z', c: ['@'], i: 8, x: 'V', z: 'C' }]));
opra.emit('message', encode([{ T: 'q', S: contracts[0].symbol, bp: 1.2, ap: 1.25, t: '2026-09-21T14:00:01Z' }]));
trade.emit('message', new TextEncoder().encode(JSON.stringify({ stream: 'trade_updates', data: { event: 'fill', execution_id: 'e1', qty: '1', price: '1.25', timestamp: '2026-09-21T14:00:01Z', order: { id: 'o1', side: 'buy', client_order_id: 'v5-buy-1' } } })));
assert.equal(rawTrades[0].rawType, 'c');
assert.equal(rawTrades[1].rawType, 't');
assert.deepEqual(quotes[0], { symbol: contracts[0].symbol, bid: 1.2, ask: 1.25, timestamp: '2026-09-21T14:00:01Z', raw: { T: 'q', S: contracts[0].symbol, bp: 1.2, ap: 1.25, t: '2026-09-21T14:00:01Z' } });
assert.equal(updates[0].executionId, 'e1');
connection.subscribeOptions(['SPY260921P00600000']);
opra.emit('message', encode([{ T: 'subscription', quotes: [contracts[0].symbol, 'SPY260921P00600000'] }]));
opra.emit('message', encode([{ T: 'q', S: contracts[0].symbol, bp: 1.21, ap: 1.26, t: new Date('2026-09-21T14:00:02.123Z') }]));
assert.equal(quotes.at(-1).timestamp, '2026-09-21T14:00:02.123Z', 'MsgPack Date becomes primitive ISO');
assert.equal(rawTrades[1].timestamp, '2026-09-21T14:00:01Z', 'source string precision is retained');
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let clock = 0;
let timerId = 0;
const timers = new Map();
globalThis.setTimeout = (run, delay) => { const id = ++timerId; timers.set(id, { at: clock + delay, run }); return id; };
globalThis.clearTimeout = (id) => timers.delete(id);
const advance = (ms) => {
  clock += ms;
  for (;;) {
    const due = [...timers].filter(([, timer]) => timer.at <= clock).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    timers.delete(due[0]); due[1].run();
  }
};
try {
  for (const socket of [sip, opra, trade]) socket.emit('close', { code: 1006 });
  assert.equal(disconnects.length, 3, 'one incident per stream');
  assert.equal(statuses.filter((value) => value.status === 'disconnected').length, 3);
  assert.ok([sip, opra, trade].every((socket) => socket.closed));
  sip.emit('close', { code: 1006 });
  assert.equal(disconnects.length, 3, 'duplicate close is ignored');
  advance(499);
  assert.equal(MockSocket.sockets.length, 3, 'retry is bounded by one timer per stream');
  advance(1);
  assert.equal(MockSocket.sockets.length, 6);
  assert.deepEqual(statuses.filter((value) => value.status === 'reconnecting').map((value) => value.attempt), [1, 1, 1]);
  const [sip2, opra2, trade2] = MockSocket.sockets.slice(3);
  for (const socket of [sip2, opra2, trade2]) socket.emit('open');
  assert.ok([sip2, opra2, trade2].every((socket) => wireJson(socket)[0].action === 'auth'));
  const before = [rawTrades.length, quotes.length, updates.length];
  sip.emit('message', JSON.stringify([{ T: 't', S: 'SPY', p: 602, t: '2026-09-21T14:00:03Z', c: ['@'], i: 9, x: 'V', z: 'C' }]));
  sip2.emit('message', JSON.stringify([{ T: 't', S: 'SPY', p: 602, t: '2026-09-21T14:00:03Z', c: ['@'], i: 9, x: 'V', z: 'C' }]));
  assert.equal(rawTrades.length, before[0], 'old socket and unconfirmed replacement cannot deliver SIP');
  sip2.emit('message', JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
  opra2.emit('message', encode([{ T: 'success', msg: 'authenticated' }]));
  trade2.emit('message', JSON.stringify({ stream: 'authorization', data: { status: 'authorized' } }));
  sip2.emit('message', JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
  opra2.emit('message', encode([{ T: 'success', msg: 'authenticated' }]));
  trade2.emit('message', JSON.stringify({ stream: 'authorization', data: { status: 'authorized' } }));
  assert.deepEqual(wireJson(sip2)[1], { action: 'subscribe', trades: ['SPY'] });
  assert.deepEqual(wireJson(opra2)[1], { action: 'subscribe', quotes: [contracts[0].symbol, 'SPY260921P00600000'] });
  assert.deepEqual(wireJson(trade2)[1], { action: 'listen', data: { streams: ['trade_updates'] } });
  assert.deepEqual([sip2, opra2, trade2].map((socket) => wireJson(socket).length), [2, 2, 2], 'duplicate auth ACK does not duplicate subscriptions');
  assert.equal(statuses.filter((value) => value.status === 'reconnected').length, 0, 'auth is not recovery confirmation');
  sip2.emit('message', JSON.stringify([{ T: 'subscription', trades: 'SPY' }]));
  opra2.emit('message', encode([{ T: 'subscription', quotes: contracts[0].symbol }]));
  trade2.emit('message', JSON.stringify({ stream: 'listening', data: { streams: 'trade_updates' } }));
  assert.equal(statuses.filter((value) => value.status === 'reconnected').length, 0, 'malformed ACKs do not confirm recovery');
  opra2.emit('message', encode([{ T: 'subscription', quotes: [contracts[0].symbol] }]));
  assert.equal(statuses.filter((value) => value.status === 'reconnected').length, 0, 'partial OPRA subscription is not recovered');
  opra2.emit('message', encode([{ T: 'subscription', quotes: [contracts[0].symbol, 'SPY260921P00600000'] }]));
  opra2.emit('message', encode([{ T: 'q', S: contracts[0].symbol, bp: 1.22, ap: 1.27, t: new Date('2026-09-21T14:00:03.123Z') }]));
  assert.equal(quotes.length, before[1] + 1, 'held OPRA quote resumes before SIP entry warmup');
  assert.equal(rawTrades.length, before[0], 'SIP remains unconfirmed');
  sip2.emit('message', JSON.stringify([{ T: 'subscription', trades: ['SPY'] }]));
  trade2.emit('message', JSON.stringify({ stream: 'listening', data: { streams: ['trade_updates'] } }));
  assert.equal(statuses.filter((value) => value.status === 'reconnected').length, 3);
  assert.equal(statuses.filter((value) => value.status === 'subscription_confirmed').length, 4);
  assert.equal(statuses.filter((value) => value.status === 'listening_confirmed').length, 2);
  sip2.emit('message', JSON.stringify([{ T: 't', S: 'SPY', p: 602, t: '2026-09-21T14:00:03.123456789Z', c: ['@'], i: 9, x: 'V', z: 'C' }]));
  trade2.emit('message', new TextEncoder().encode(JSON.stringify({ stream: 'trade_updates', data: { event: 'fill', execution_id: 'e2', qty: '1', price: '1.22', timestamp: '2026-09-21T14:00:03Z', order: { id: 'o2', side: 'sell', client_order_id: 'v5-sell-2' } } })));
  assert.deepEqual([rawTrades.length, quotes.length, updates.length], before.map((n) => n + 1), 'all source events resume');
  assert.equal(rawTrades.at(-1).timestamp, '2026-09-21T14:00:03.123456789Z');
  assert.equal(quotes.at(-1).timestamp, '2026-09-21T14:00:03.123Z');
  for (const url of [sip2.url, opra2.url, trade2.url]) assert.equal(MockSocket.sockets.filter((socket) => socket.url === url && !socket.closed).length, 1, 'one live socket per stream');
  const subscribedCount = wireJson(opra2).length;
  connection.subscribeOptions([contracts[0].symbol, 'SPY260921P00600000']);
  assert.equal(wireJson(opra2).length, subscribedCount, 'no duplicate OPRA subscription');
  sip2.emit('close', { code: 1006 });
  advance(500);
  const sip3 = MockSocket.sockets.at(-1);
  sip3.emit('open');
  const priorRecovered = statuses.filter((value) => value.status === 'reconnected').length;
  const priorDelivered = [rawTrades.length, quotes.length, updates.length];
  sip3.emit('message', '{broken');
  assert.equal(statuses.at(-1).status, 'disconnected', 'malformed retry remains unconfirmed');
  assert.equal(statuses.filter((value) => value.status === 'reconnected').length, priorRecovered);
  assert.deepEqual([rawTrades.length, quotes.length, updates.length], priorDelivered, 'malformed retry invents no events');
  const incidents = disconnects.length;
  trade2.emit('error', new Error('transport failure'));
  trade2.emit('close', { code: 1006 });
  assert.equal(disconnects.length, incidents + 1, 'error and close are one incident');
  const afterMalformed = MockSocket.sockets.length;
  connection.stop();
  advance(10_000);
  assert.equal(MockSocket.sockets.length, afterMalformed, 'explicit stop cancels retries');
  sip3.emit('message', JSON.stringify([{ T: 't', S: 'SPY', p: 603, t: '2026-09-21T14:00:04Z', c: ['@'], i: 10, x: 'V', z: 'C' }]));
  trade2.emit('message', JSON.stringify({ stream: 'trade_updates', data: { event: 'fill', execution_id: 'e3', qty: '1', price: '1.22', order: { id: 'o3', side: 'sell' } } }));
  assert.deepEqual([rawTrades.length, quotes.length, updates.length], priorDelivered, 'stopped sockets cannot deliver');
  assert.ok(MockSocket.sockets.filter((socket) => !socket.closed).length === 0, 'one socket authority per stream');
} finally {
  connection.stop();
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}
assert.equal(MockSocket.sockets.every((socket) => socket.closed), true);
assert.ok(requests.some((url) => url.includes('feed=opra')));

const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
const nativeDateNow = Date.now;
const heartbeatTicks = [];
const clearedIntervals = [];
let heartbeatNow = 10_000;
globalThis.setInterval = (run, delay) => { assert.equal(delay, 10_000); heartbeatTicks.push(run); return heartbeatTicks.length; };
globalThis.clearInterval = (handle) => clearedIntervals.push(handle);
Date.now = () => heartbeatNow;
const heartbeatDisconnects = [];
const heartbeatEvents = [];
const priorSocketCount = MockSocket.sockets.length;
const heartbeatConnection = providers.connect({ onDisconnect: (event) => heartbeatDisconnects.push(event), onStatus: (event) => heartbeatEvents.push(event) });
try {
  assert.equal(heartbeatTicks.length, 3, 'each transport has one heartbeat monitor');
  const heartbeatSockets = MockSocket.sockets.slice(priorSocketCount);
  for (const socket of heartbeatSockets) socket.emit('open');
  heartbeatNow += 10_000;
  for (const tick of heartbeatTicks) tick();
  assert.deepEqual(heartbeatSockets.map((socket) => socket.pings), [1, 1, 1], 'each live ws transport sends a protocol ping');
  for (const socket of heartbeatSockets) socket.emit('pong');
  heartbeatNow += 25_001;
  for (const tick of heartbeatTicks) tick();
  assert.equal(heartbeatDisconnects.length, 3, 'missing pong triggers one disconnect per transport');
  assert.ok(heartbeatEvents.filter((event) => event.status === 'disconnected').every((event) => event.event.reason === 'heartbeat_timeout'));
  assert.ok(heartbeatSockets.every((socket) => socket.terminated), 'unresponsive sockets are terminated');
} finally {
  heartbeatConnection.stop();
  globalThis.setInterval = nativeSetInterval;
  globalThis.clearInterval = nativeClearInterval;
  Date.now = nativeDateNow;
}
assert.equal(clearedIntervals.length, 3, 'stop clears every heartbeat monitor');
