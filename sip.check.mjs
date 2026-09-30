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
const start = Date.parse(base) - 30_000;
signal.reset(start);
const feed = (timestamp, price, tradeId) => processor.onRawTrade(raw({ timestamp, price, tradeId }), Date.parse(timestamp));
processor.reset();
const signalProcessor = createSipProcessor({ onTrade: (trade, now) => signal.onTrade(trade, now), onCorrection: (change, now) => signal.onCorrection(change, now), onCancel: (change, now) => signal.onCancel(change, now) });
const at = (ns, price, tradeId) => signalProcessor.onRawTrade(raw({ timestamp: `2026-09-21T13:33:${ns}`, price, tradeId }), Date.parse(`2026-09-21T13:33:${ns}`));

at('01.000000000Z', 100, 10);
at('01.100000000Z', 101, 11);
assert.equal(events.length, 1, 'normal symmetric breakout remains');
events.length = 0;
assert.equal(signalProcessor.onRawTrade({ T: 'c', S: 'SPY', oi: 10, ci: 12, cp: 102, cc: [' '], x: 'K', z: 'B', t: '2026-09-21T13:33:02Z' }, Date.parse('2026-09-21T13:33:02Z')).updated, true);
assert.equal(events.length, 0, 'correction does not independently signal');
at('02.000000000Z', 101.5, 13);
assert.equal(events.length, 0, 'corrected active observation changes future range');
assert.equal(signalProcessor.onRawTrade({ T: 'x', S: 'SPY', i: 12, x: 'K', z: 'B', t: '2026-09-21T13:33:02Z' }, Date.parse('2026-09-21T13:33:02Z')).removed, true);
assert.equal(events.length, 0, 'cancel does not independently signal');
at('02.100000000Z', 102, 14);
assert.equal(events.at(-1).direction, 'CALL', 'active-window cancel removes observation');

const late = signalProcessor.onRawTrade(raw({ timestamp: '2026-09-21T13:33:01.000000001Z', tradeId: 15, price: 999 }), Date.parse('2026-09-21T13:33:03Z'));
assert.equal(late.accepted, false, 'late ordinary print ignored');

const equalEvents = [];
const equalSignal = createSignal({ onBreakout: (event) => equalEvents.push(event) });
equalSignal.setSession({ date: '2026-09-21', open: '2026-09-21T13:30:00.000Z', close: '2026-09-21T20:00:00.000Z' });
equalSignal.reset(Date.parse('2026-09-21T13:32:30Z'));
equalSignal.onTrade({ timestamp: '2026-09-21T13:33:01.000000000Z', price: 100 }, Date.parse('2026-09-21T13:33:01Z'));
equalSignal.onTrade({ timestamp: '2026-09-21T13:33:01.000000000Z', price: 101 }, Date.parse('2026-09-21T13:33:01Z'));
assert.equal(equalEvents.at(-1).direction, 'CALL', 'equal source timestamps use receipt order deterministically');

console.log('sip.check.mjs: approved SIP eligibility, ordering, correction, and cancel rules pass');
