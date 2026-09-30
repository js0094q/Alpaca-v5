import assert from 'node:assert/strict';
import { createRuntime } from './runtime.mjs';
import { handleProviderStatus } from './paper.mjs';
import { createCalendar } from './providers.mjs';
import { createLedger } from './ledger.mjs';
import { createContinuity } from './continuity.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const option = (symbol, strike) => ({ symbol, strike });
const makeBroker = (positions = []) => ({
  inspectCurrentState: async () => ({ positions, orders: [] }),
  submitOrder: async () => ({ id: 'unused', status: 'new' }),
  replaceOrder: async () => ({ id: 'unused-replacement', status: 'new' }),
  cancelOrder: async () => {},
});
const continuity = () => createContinuity({ path: join(mkdtempSync(join(tmpdir(), 'v5-lifecycle-')), 'state.json') });

let wall = Date.parse('2026-09-21T13:00:00Z');
let mono = 0;
const ledgers = [];
const ledgerOutput = [];
const reporting = createLedger({ write: (line) => ledgerOutput.push(line) });
const session = { date: '2026-09-21', open: '2026-09-21T13:30:00Z', close: '2026-09-21T20:00:00Z' };
const nextSession = { date: '2026-09-23', open: '2026-09-23T13:30:00Z', close: '2026-09-23T20:00:00Z' };
const calendar = createCalendar({
  baseUrl: 'https://paper-api.alpaca.markets',
  key: 'test-key',
  secret: 'test-secret',
  fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify([
    { date: '2026-09-21', open: '09:30', close: '16:00' },
    { date: '2026-09-23', open: '09:30', close: '16:00' },
  ]) }),
});
await calendar.loadCalendar({ start: '2026-09-21', end: '2026-09-23' });
const runtime = createRuntime({
  broker: makeBroker(),
  calendar,
  now: () => wall,
  nowMono: () => mono,
  ledger: (event) => { ledgers.push(event); reporting.record(event); },
  continuity: continuity(),
  getContracts: async () => [option('SPY260923C00659000', 659), option('SPY260923C00661000', 661)],
  getQuote: async (symbol) => ({ symbol, bid: 1, ask: 1.01, timestamp: new Date(wall).toISOString() }),
});

await runtime.startup();
assert.equal(runtime.getState().state, 'WAITING');
wall = Date.parse(session.open);
runtime.tick();
assert.equal(runtime.getState().state, 'FLAT');
assert.equal(runtime.onRawTrade({ symbol: 'SPY', price: 660 }).accepted, false);
assert.equal(runtime.getState().blockers.length, 0);
runtime.onMarketDataReconnect();
assert.equal(runtime.getState().warmupUntil, wall + 30_000);

// The first two minutes remain entry-ineligible, and the 15:30 cutoff remains closed.
wall += 31_000;
runtime.onTrade({ timestamp: new Date(wall).toISOString(), price: 659 });
wall = Date.parse('2026-09-21T15:29:59-04:00');
runtime.onTrade({ timestamp: new Date(wall).toISOString(), price: 659 });
wall = Date.parse('2026-09-21T15:30:00-04:00');
runtime.onTrade({ timestamp: new Date(wall).toISOString(), price: 661 });
assert.equal(runtime.getState().state, 'FLAT');

wall = Date.parse(nextSession.open);
runtime.tick();
assert.equal(runtime.getState().sessionDate, nextSession.date);
assert.ok(ledgers.some(({ event, date }) => event === 'DAY_FINALIZE' && date === session.date));
assert.ok(ledgers.some(({ event, date }) => event === 'DAY_START' && date === nextSession.date));
assert.ok(ledgerOutput.some((line) => line.includes('Finalized trading day 2026-09-21')));

wall += 121_000;
for (let i = 0; i < 31; i += 1) runtime.onTrade({ timestamp: new Date(wall + i).toISOString(), price: 659 });
runtime.onTrade({ timestamp: new Date(wall + 32).toISOString(), price: 660 });
await new Promise((resolve) => setImmediate(resolve));
assert.notEqual(runtime.getState().entry.pausedReason, 'AMBIGUOUS_ATM');
assert.equal(runtime.getState().blockers.length, 0);

const gateOrders = [];
const gateRuntime = createRuntime({
  broker: {
    inspectCurrentState: async () => ({ positions: [], orders: [] }),
    submitOrder: async (order) => { gateOrders.push(order); return { id: 'gate-buy', status: 'new' }; },
    replaceOrder: async () => ({ id: 'gate-replace', status: 'new' }),
    cancelOrder: async () => {},
  },
  calendar, now: () => wall, nowMono: () => mono,
  getContracts: async () => [option('SPY260923C00660000', 660)],
  getQuote: async (symbol) => ({ symbol, bid: 1, ask: 1.01, timestamp: new Date(wall).toISOString() }),
  continuity: continuity(),
});
wall = Date.parse(nextSession.open);
await gateRuntime.startup();
wall += 119_999;
gateRuntime.onTrade({ timestamp: new Date(wall).toISOString(), price: 659 });
gateRuntime.onTrade({ timestamp: new Date(wall + 1).toISOString(), price: 661 });
assert.equal(gateOrders.length, 0);
wall += 1;
gateRuntime.onTrade({ timestamp: new Date(wall).toISOString(), price: 659 });
wall += 1;
gateRuntime.onTrade({ timestamp: new Date(wall).toISOString(), price: 662 });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(gateOrders.length, 1);
gateRuntime.stop();

const reconnectOrders = [];
const reconnectRuntime = createRuntime({
  broker: {
    inspectCurrentState: async () => ({ positions: [], orders: [] }),
    submitOrder: async (order) => { reconnectOrders.push(order); return { id: 'reconnect-buy', status: 'new' }; },
    replaceOrder: async () => ({ id: 'reconnect-replace', status: 'new' }),
    cancelOrder: async () => {},
  },
  calendar, now: () => wall, nowMono: () => mono,
  getContracts: async () => [option('SPY260923C00660000', 660)],
  getQuote: async (symbol) => ({ symbol, bid: 1, ask: 1.01, timestamp: new Date(wall).toISOString() }),
  continuity: continuity(),
});
await reconnectRuntime.startup();
const sipStream = 'wss://stream.data.alpaca.markets/v2/sip';
const statusEvents = [];
const status = (stream, state, attempt) => handleProviderStatus(reconnectRuntime, (event, fields) => statusEvents.push({ event, fields }), { stream, status: state, attempt });
const initialWarmup = reconnectRuntime.getState().warmupUntil;
for (const stream of ['wss://stream.data.alpaca.markets/v1beta1/opra', 'wss://paper-api.alpaca.markets/stream']) {
  status(stream, 'disconnected'); status(stream, 'reconnected', 1);
}
assert.equal(reconnectRuntime.getState().warmupUntil, initialWarmup, 'OPRA and trade-update reconnects do not reset entry warmup');
status(sipStream, 'disconnected');
assert.equal(reconnectRuntime.getState().warmupUntil, wall + 30_000);
wall += 1_000;
status(sipStream, 'authenticated'); status(sipStream, 'subscription_confirmed');
assert.equal(reconnectRuntime.getState().warmupUntil, wall + 29_000, 'auth and subscription ACKs do not reset warmup');
status(sipStream, 'reconnected', 1);
assert.equal(reconnectRuntime.getState().warmupUntil, wall + 30_000, 'SIP recovery starts a fresh warmup');
assert.equal(statusEvents.at(-1).fields.attempt, 1, 'retry attempt stays primitive in status telemetry');
wall += 29_999;
reconnectRuntime.onTrade({ timestamp: new Date(wall).toISOString(), price: 659 });
reconnectRuntime.onTrade({ timestamp: new Date(wall + 1).toISOString(), price: 662 });
assert.equal(reconnectOrders.length, 0);
wall += 2;
reconnectRuntime.onTrade({ timestamp: new Date(wall).toISOString(), price: 659 });
wall += 1;
reconnectRuntime.onTrade({ timestamp: new Date(wall).toISOString(), price: 663 });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(reconnectOrders.length, 1);
reconnectRuntime.stop();

const throwingLedger = createRuntime({
  broker: makeBroker(), calendar, now: () => wall, nowMono: () => mono,
  ledger: async () => { throw new Error('reporting unavailable'); },
  getContracts: async () => [], getQuote: async () => null, continuity: continuity(),
});
await throwingLedger.startup();
throwingLedger.tick();
throwingLedger.stop();

const blocked = createRuntime({
  broker: makeBroker([{ symbol: 'SPY260923C00660000', qty: 1 }]), calendar, now: () => wall, nowMono: () => mono,
  getContracts: async () => [], getQuote: async () => null, continuity: continuity(),
});
await blocked.startup();
assert.equal(blocked.getState().state, 'RECOVERING');
assert.equal(blocked.getState().blockers.length, 0);
blocked.stop();
runtime.stop();
console.log('lifecycle.check ok');
