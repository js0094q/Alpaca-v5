import assert from 'node:assert/strict';
import { createSignal } from './signal.mjs';

const date = '2026-09-23';
const open = Date.parse(`${date}T13:30:00Z`);
const rangeEnd = open + 15 * 60_000;
const cutoff = open + 2 * 60 * 60_000;
const session = { date, open, close: Date.parse(`${date}T20:00:00Z`) };
const events = [];
const signal = createSignal({ onBreakout: (event) => events.push(event) });
signal.setSession(session);
signal.onMarketDataStatus({ status: 'subscription_confirmed', timestamp: open - 1_000 });
const trade = (at, price, now = at, tradeId) => signal.onTrade({ timestamp: at, price, tradeId, exchange: 'Q' }, now);

signal.reset(open - 1);
assert.equal(trade(open, 100).accepted, true, '09:30 inclusive contributes to range');
trade(open + 14 * 60_000 + 59_999, 102);
assert.equal(trade(rangeEnd, 102).accepted, true, 'a covered 09:45 print inside the margin is accepted');
assert.equal(events.length, 0);
assert.equal(trade(rangeEnd, 102.2).accepted, true, '09:45 inclusive can trigger at the threshold');
assert.equal(events.at(-1).direction, 'CALL');
assert.equal(events.at(-1).openingRangeHigh, 102);
assert.equal(events.at(-1).openingRangeLow, 100);
assert.equal(events.at(-1).openingRangeCount, 2, '09:45 prints are excluded from the range');

const before = events.length;
trade(rangeEnd + 1, 102.19);
assert.equal(events.length, before, 'price inside the range-relative margin does not signal');
trade(rangeEnd + 2, 102.20);
assert.equal(events.at(-1).direction, 'CALL', 'threshold is inclusive');
trade(rangeEnd + 3, 99.80);
assert.equal(events.at(-1).direction, 'PUT', 'downside threshold is inclusive and symmetric');
assert.equal(trade(cutoff, 110).reason, 'entry-cutoff', '11:30 source timestamp is excluded');
assert.equal(trade(cutoff - 1, 110, cutoff).reason, 'entry-cutoff', '11:30 wall clock is excluded');

signal.reset(open + 1);
signal.onMarketDataStatus({ status: 'subscription_confirmed', timestamp: open + 2 });
trade(rangeEnd, 110);
assert.equal(events.at(-1).openingRangeHigh, 102, 'reset invalidates old range and late subscription cannot restore coverage');
assert.equal(events.length, before + 2, 'reset cannot signal from incomplete new range');

const correctedEvents = [];
const corrected = createSignal({ onBreakout: (event) => correctedEvents.push(event) });
corrected.setSession(session);
corrected.onMarketDataStatus({ status: 'subscription_confirmed', timestamp: open - 1_000 });
corrected.reset(open - 1);
corrected.onTrade({ timestamp: open, price: 100, tradeId: 'a', exchange: 'Q' }, open);
corrected.onTrade({ timestamp: open + 60_000, price: 102, tradeId: 'b', exchange: 'Q' }, open + 60_000);
corrected.onCorrection({ originalTradeId: 'b', exchange: 'Q', correctedTrade: { price: 101 } }, rangeEnd);
corrected.onTrade({ timestamp: rangeEnd, price: 101.10 }, rangeEnd);
assert.equal(correctedEvents.at(-1).direction, 'CALL', 'corrected high is used for inclusive threshold');
assert.equal(correctedEvents.at(-1).openingRangeHigh, 101);
corrected.onCancel({ tradeId: 'b', exchange: 'Q' }, rangeEnd + 1);
const afterCancel = correctedEvents.length;
corrected.onTrade({ timestamp: rangeEnd + 2, price: 100 }, rangeEnd + 2);
assert.equal(correctedEvents.length, afterCancel, 'cancel updates the frozen range before later signal decisions');

const late = createSignal({ onBreakout: () => {} });
late.setSession(session);
late.onMarketDataStatus({ status: 'subscription_confirmed', timestamp: open - 1_000 });
late.reset(open + 1);
assert.equal(late.onTrade({ timestamp: rangeEnd, price: 101 }, rangeEnd).reason, 'opening-range-coverage', 'reset after the open cannot claim full-day coverage');

const lateSubscription = createSignal({ onBreakout: () => {} });
lateSubscription.setSession(session);
lateSubscription.reset(open - 1);
lateSubscription.onMarketDataStatus({ status: 'subscription_confirmed', timestamp: open + 60_000 });
lateSubscription.onTrade({ timestamp: open, price: 100 }, open);
assert.equal(lateSubscription.onTrade({ timestamp: rangeEnd, price: 101 }, rangeEnd).reason, 'opening-range-coverage', 'subscription after 09:30 cannot certify the full window');

const delayedClock = createSignal({ onBreakout: () => {} });
delayedClock.setSession(session);
delayedClock.onMarketDataStatus({ status: 'subscription_confirmed', timestamp: open - 1_000 });
delayedClock.reset(open - 1);
delayedClock.onTrade({ timestamp: open, price: 100 }, open);
delayedClock.onTrade({ timestamp: rangeEnd, price: 110 }, rangeEnd - 1);
assert.equal(delayedClock.canEnter(rangeEnd - 1), false, 'source time at 09:45 cannot signal before wall clock reaches 09:45');
assert.equal(delayedClock.onTrade({ timestamp: rangeEnd + 1, price: 110 }, rangeEnd + 1).accepted, true);

const reconnect = createSignal({ onBreakout: () => {} });
reconnect.setSession(session);
reconnect.onMarketDataStatus({ status: 'subscription_confirmed', timestamp: open - 1_000 });
reconnect.reset(open - 1);
reconnect.onTrade({ timestamp: open, price: 100 }, open);
reconnect.onMarketDataStatus({ status: 'disconnected', timestamp: open + 5 * 60_000 });
reconnect.onMarketDataStatus({ status: 'reconnected', timestamp: open + 6 * 60_000 });
assert.equal(reconnect.onTrade({ timestamp: rangeEnd, price: 101 }, rangeEnd).reason, 'opening-range-coverage', 'reconnect gap during opening window permanently invalidates it');

const afterWindowReconnect = createSignal({ onBreakout: () => {} });
afterWindowReconnect.setSession(session);
afterWindowReconnect.onMarketDataStatus({ status: 'subscription_confirmed', timestamp: open - 1_000 });
afterWindowReconnect.reset(open - 1);
afterWindowReconnect.onTrade({ timestamp: open, price: 100 }, open);
afterWindowReconnect.onTrade({ timestamp: open + 1_000, price: 99.9 }, open + 1_000);
afterWindowReconnect.onMarketDataStatus({ status: 'disconnected', timestamp: rangeEnd });
assert.equal(afterWindowReconnect.canEnter(rangeEnd + 1), false, 'current disconnection blocks pending entry');
afterWindowReconnect.onMarketDataStatus({ status: 'reconnected', timestamp: rangeEnd + 1_000 });
afterWindowReconnect.onTrade({ timestamp: rangeEnd + 1_001, price: 100.05 }, rangeEnd + 1_001);
assert.equal(afterWindowReconnect.canEnter(rangeEnd + 1_001), true, 'post-window reconnect retains a fully observed range');

const minimumMarginEvents = [];
const minimumMargin = createSignal({ onBreakout: (event) => minimumMarginEvents.push(event) });
minimumMargin.setSession(session);
minimumMargin.onMarketDataStatus({ status: 'subscription_confirmed', timestamp: open - 1_000 });
minimumMargin.reset(open - 1);
minimumMargin.onTrade({ timestamp: open, price: 100 }, open);
minimumMargin.onTrade({ timestamp: open + 1_000, price: 99.9 }, open + 1_000);
minimumMargin.onTrade({ timestamp: rangeEnd, price: 100.04 }, rangeEnd);
assert.equal(minimumMarginEvents.length, 0, 'the five cent floor applies to a narrow range');
minimumMargin.onTrade({ timestamp: rangeEnd + 1, price: 100.05 }, rangeEnd + 1);
assert.equal(minimumMarginEvents.at(-1).direction, 'CALL', 'the minimum margin threshold is inclusive');
assert.equal(minimumMargin.canEnter(rangeEnd + 1), true);
assert.equal(minimumMargin.canEnter(cutoff), false, 'pending submission at 11:30 is blocked');

console.log('signal.check.mjs: opening range rules pass');
