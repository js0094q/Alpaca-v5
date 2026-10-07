import assert from 'node:assert/strict';
import { createSignal } from './signal.mjs';
import { createSipProcessor, tradeEligibility } from './sip.mjs';

const base = '2026-09-21T13:33:00.000000000Z';
const raw = (overrides = {}) => ({
  symbol: 'SPY', tradeId: 1, exchange: 'K', tape: 'B', price: 100,
  timestamp: base, conditions: [' '], rawType: 't', ...overrides,
});

assert.equal(tradeEligibility(raw()).eligible, true, 'ordinary eligible print');
assert.equal(tradeEligibility(raw({ conditions: ['B'] })).eligible, false, 'ineligible condition');
assert.equal(tradeEligibility(raw({ conditions: [' ', 'I'] })).eligible, false, 'strictest condition wins');
assert.equal(tradeEligibility(raw({ conditions: ['?'] })).eligible, false, 'unknown condition fails closed');
assert.equal(tradeEligibility(raw({ tape: 'C', conditions: ['@'] })).eligible, true, 'C tape regular sale');
assert.equal(tradeEligibility(raw({ tape: 'C', conditions: ['B'] })).eligible, true, 'C tape bunched trade');
assert.equal(tradeEligibility(raw({ tape: 'B', conditions: ['@'] })).eligible, false, 'unsupported tape/condition fails closed');

const accepted = [];
const processor = createSipProcessor({ onTrade: (trade) => accepted.push(trade) });
assert.equal(processor.onRawTrade(raw(), Date.parse(base)).accepted, true);
assert.equal(processor.onRawTrade(raw(), Date.parse(base)).reason, 'duplicate');
assert.equal(accepted.length, 1);
const wrapped = createSipProcessor({ onTrade: (trade) => accepted.push(trade) });
assert.equal(wrapped.onRawTrade({ T: 't', S: 'SPY', i: 2, x: 'K', p: 100, c: ['B'], z: 'C', t: base }, Date.parse(base)).accepted, true, 'raw provider frame is normalized');
const boundary = createSipProcessor({ onTrade: () => {}, onCorrection: () => ({ updated: true }) });
boundary.onRawTrade(raw({ tradeId: 20 }), base);
assert.equal(boundary.onRawTrade({ T: 'c', S: 'SPY', oi: 20, ci: 21, cp: 100, cc: [' '], x: 'K', z: 'B', t: base }, '2026-09-21T13:33:29.999999999Z').updated, true, 'nanosecond active-window boundary retained');
assert.equal(boundary.onRawTrade({ T: 'c', S: 'SPY', oi: 21, ci: 22, cp: 100, cc: [' '], x: 'K', z: 'B', t: base }, '2026-09-21T13:33:30.000000000Z').updated, false, 'nanosecond-expired correction ignored');

const events = [];
const signal = createSignal({ onBreakout: (event) => events.push(event) });
signal.setSession({ date: '2026-09-21', open: '2026-09-21T13:30:00.000Z', close: '2026-09-21T20:00:00.000Z' });
const open = Date.parse('2026-09-21T13:30:00Z');
const start = open - 1_000;
signal.reset(start);
signal.onMarketDataStatus({ status: 'subscription_confirmed', timestamp: start });
const feed = (timestamp, price, tradeId) => processor.onRawTrade(raw({ timestamp, price, tradeId }), Date.parse(timestamp));
processor.reset();
const signalProcessor = createSipProcessor({ onTrade: (trade, now) => signal.onTrade(trade, now), onCorrection: (change, now) => signal.onCorrection(change, now), onCancel: (change, now) => signal.onCancel(change, now) });
const at = (time, price, tradeId) => signalProcessor.onRawTrade(raw({ timestamp: time, price, tradeId }), Date.parse(time));

at('2026-09-21T13:31:00.000000000Z', 100, 10);
at('2026-09-21T13:44:59.000000000Z', 101, 11);
assert.equal(events.length, 0, 'opening-range prints build coverage without triggering');
at('2026-09-21T13:45:00.000000000Z', 101.11, 12);
assert.equal(events.length, 1, 'covered opening-range breakout triggers at 09:45');
events.length = 0;
assert.equal(signalProcessor.onRawTrade({ T: 'c', S: 'SPY', oi: 11, ci: 13, cp: 100.5, cc: [' '], x: 'K', z: 'B', t: '2026-09-21T13:45:01Z' }, Date.parse('2026-09-21T13:45:01Z')).updated, true);
assert.equal(events.length, 0, 'correction does not independently signal');
at('2026-09-21T13:45:02.000000000Z', 101.11, 14);
assert.equal(events.length, 1, 'corrected range changes the next breakout decision');
events.length = 0;
assert.equal(signalProcessor.onRawTrade({ T: 'x', S: 'SPY', i: 13, x: 'K', z: 'B', t: '2026-09-21T13:45:03Z' }, Date.parse('2026-09-21T13:45:03Z')).removed, true);
assert.equal(events.length, 0, 'cancel does not independently signal');

const late = signalProcessor.onRawTrade(raw({ timestamp: '2026-09-21T13:45:01.999999999Z', tradeId: 15, price: 999 }), Date.parse('2026-09-21T13:45:03Z'));
assert.equal(late.accepted, false, 'late ordinary print ignored');

const equalEvents = [];
const equalSignal = createSignal({ onBreakout: (event) => equalEvents.push(event) });
equalSignal.setSession({ date: '2026-09-21', open: '2026-09-21T13:30:00.000Z', close: '2026-09-21T20:00:00.000Z' });
equalSignal.reset(open - 1);
equalSignal.onMarketDataStatus({ status: 'subscription_confirmed', timestamp: open - 1 });
equalSignal.onTrade({ timestamp: '2026-09-21T13:30:01.000000000Z', price: 100 }, Date.parse('2026-09-21T13:30:01Z'));
equalSignal.onTrade({ timestamp: '2026-09-21T13:44:59.000000000Z', price: 101 }, Date.parse('2026-09-21T13:44:59Z'));
equalSignal.onTrade({ timestamp: '2026-09-21T13:45:01.000000000Z', price: 101.11 }, Date.parse('2026-09-21T13:45:01Z'));
assert.equal(equalEvents.at(-1).direction, 'CALL', 'opening-range timestamps produce deterministic breakout direction');

console.log('sip.check.mjs: approved SIP eligibility, ordering, correction, and cancel rules pass');
