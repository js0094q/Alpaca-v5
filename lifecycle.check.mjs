import assert from 'node:assert/strict';
import { createRuntime } from './runtime.mjs';
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
runtime.onMarketDataStatus({ status: 'subscription_confirmed', timestamp: Date.parse(session.open) - 1 });
wall = Date.parse(session.open);
runtime.tick();
assert.equal(runtime.getState().state, 'FLAT');
assert.equal(runtime.onRawTrade({ symbol: 'SPY', price: 660 }).accepted, false);
assert.equal(runtime.getState().blockers.length, 0);
runtime.onTrade({ timestamp: '2026-09-21T13:31:00Z', price: 659 }, Date.parse('2026-09-21T13:31:00Z'));
runtime.onMarketDataStatus({ status: 'disconnected', timestamp: Date.parse('2026-09-21T13:35:00Z') });
runtime.onMarketDataStatus({ status: 'subscription_confirmed', timestamp: Date.parse('2026-09-21T13:40:00Z') });
runtime.onTrade({ timestamp: '2026-09-21T13:44:59Z', price: 660 }, Date.parse('2026-09-21T13:44:59Z'));
const missedOpeningRange = runtime.onTrade({ timestamp: '2026-09-21T13:45:00Z', price: 661 }, Date.parse('2026-09-21T13:45:00Z'));
assert.equal(missedOpeningRange.accepted, false, 'a mid-range feed gap invalidates opening-range coverage for the day');
assert.equal(runtime.getState().state, 'FLAT');

wall = Date.parse(nextSession.open);
runtime.tick();
assert.equal(runtime.getState().sessionDate, nextSession.date);
assert.ok(ledgers.some(({ event, date }) => event === 'DAY_FINALIZE' && date === session.date));
assert.ok(ledgers.some(({ event, date }) => event === 'DAY_START' && date === nextSession.date));
assert.ok(ledgerOutput.some((line) => line.includes('Finalized trading day 2026-09-21')));

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
wall = Date.parse(nextSession.open) - 1_000;
await gateRuntime.startup();
gateRuntime.onMarketDataStatus({ status: 'subscription_confirmed', timestamp: wall });
wall = Date.parse(nextSession.open);
gateRuntime.tick();
wall = Date.parse(nextSession.open) + 60_000;
gateRuntime.onTrade({ timestamp: new Date(wall).toISOString(), price: 659 });
wall = Date.parse(nextSession.open) + 14 * 60_000;
gateRuntime.onTrade({ timestamp: new Date(wall).toISOString(), price: 661 });
assert.equal(gateOrders.length, 0, 'opening-range observations do not submit an entry');
wall = Date.parse(nextSession.open) + 15 * 60_000;
gateRuntime.onTrade({ timestamp: new Date(wall).toISOString(), price: 662 });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(gateOrders.length, 1);
gateRuntime.stop();

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
