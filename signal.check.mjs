import assert from 'node:assert/strict';
import { createSignal } from './signal.mjs';

const session = {
  date: '2026-09-23',
  open: '2026-09-23T13:30:00.000Z',
  close: '2026-09-23T20:00:00.000Z',
};
const events = [];
const signal = createSignal({ onBreakout: (event) => events.push(event) });
signal.setSession(session);

const feed = (sourceMs, price, nowMs = sourceMs) => signal.onTrade({
  timestamp: new Date(sourceMs).toISOString(),
  price,
}, nowMs);

const base = Date.parse('2026-09-23T13:33:00.000Z');
signal.reset(base);
feed(base + 1_000, 102);
feed(base + 10_000, 100);
feed(base + 29_000, 100);
feed(base + 30_000, 101);
assert.equal(events.length, 0, 'first post-warmup sample does not break prior high');
feed(base + 30_500, 103);
assert.equal(events.at(-1).direction, 'CALL');
feed(base + 31_000, 103);
assert.equal(events.length, 1, 'equality does not emit');
feed(base + 31_500, 99);
assert.equal(events.at(-1).direction, 'PUT');

signal.reset(base + 40_000);
feed(base + 41_000, 100);
feed(base + 50_000, 101);
feed(base + 69_000, 99);
assert.equal(events.length, 2, 'reconnect warmup suppresses emissions');
feed(base + 70_000, 102);
assert.equal(events.at(-1).direction, 'CALL');

const entry = Date.parse('2026-09-23T13:31:30.000Z');
signal.reset(entry);
const beforeOpening = events.length;
feed(entry + 1_000, 100);
feed(entry + 10_000, 100);
feed(entry + 29_000, 100);
assert.equal(events.length, beforeOpening, '09:31:59 ET remains entry-ineligible');
feed(entry + 30_000, 101);
assert.equal(events.length, beforeOpening + 1, '09:32 ET emits a new entry signal');
assert.equal(events.at(-1).direction, 'CALL', '09:32 ET permits entry');

const cutoff = Date.parse('2026-09-23T15:29:28.000-04:00');
signal.reset(cutoff);
feed(cutoff + 1_000, 100);
feed(cutoff + 10_000, 100);
feed(cutoff + 29_000, 100);
const beforeCutoff = events.length;
feed(Date.parse('2026-09-23T15:29:59.000-04:00'), 101);
assert.equal(events.length, beforeCutoff + 1, '15:29:59 ET permits entry');
feed(Date.parse('2026-09-23T15:29:59.999-04:00'), 102);
assert.equal(events.length, beforeCutoff + 2, '15:29:59.999 ET permits entry');
for (const time of ['15:30:00.000', '15:30:00.001', '15:31:00.000']) {
  assert.equal(feed(Date.parse(`2026-09-23T${time}-04:00`), 103).reason, 'entry-cutoff');
  assert.equal(events.length, beforeCutoff + 2, `${time} ET suppresses entry`);
}

console.log('signal.check.mjs: approved WS1 rules pass');

// A caller may choose an earlier session cutoff; the default cutoff is 15:30 ET.
const extended = createSignal({ onBreakout: () => {}, entryCutoffMinuteET: 925 });
extended.setSession(session);
for (const [clock, accepted] of [['13:00:00.000', true], ['15:24:59.999', true], ['15:25:00.000', false]]) {
  const at = Date.parse(`2026-09-23T${clock}-04:00`);
  assert.equal(extended.onTrade({ timestamp: at, price: 100 }, at).accepted, accepted);
}
const brokerCutoff = createSignal({ onBreakout: () => {}, entryCutoffMinuteET: 16 * 60 });
brokerCutoff.setSession(session);
for (const [clock, accepted] of [['15:29:59.999', true], ['15:30:00.000', false]]) {
  const at = Date.parse(`2026-09-23T${clock}-04:00`);
  assert.equal(brokerCutoff.onTrade({ timestamp: at, price: 100 }, at).accepted, accepted);
}
for (const invalid of [-1, 1440, 925.5, NaN, '925']) assert.throws(() => createSignal({ onBreakout: () => {}, entryCutoffMinuteET: invalid }), RangeError);

const sourceEvents = [];
const sourceGated = createSignal({ onBreakout: (event) => sourceEvents.push(event) });
sourceGated.setSession(session);
const open = Date.parse('2026-09-23T13:30:00.000Z');
sourceGated.reset(open);
assert.equal(sourceGated.onTrade({ timestamp: open - 1, price: 1_000 }, open + 1_000).reason, 'outside-session', 'premarket source print cannot seed the regular-session window');
sourceGated.onTrade({ timestamp: open + 10_000, price: 100 }, open + 10_000);
sourceGated.onTrade({ timestamp: open + 20_000, price: 101 }, open + 20_000);
assert.equal(sourceGated.onTrade({ timestamp: open + 120_000 - 1, price: 99 }, open + 120_000 + 1_000).accepted, true);
assert.equal(sourceEvents.length, 0, 'a delayed pre-09:32 source print cannot trigger an entry after 09:32');
sourceGated.onTrade({ timestamp: open + 126_000, price: 98.5 }, open + 126_000);
assert.equal(sourceEvents.at(-1).direction, 'PUT', 'a fresh post-09:32 source print can qualify');

// Breakout margin: clear the 30s range by max(2c, 20% of range).
const marginEvents = [];
const margined = createSignal({ onBreakout: (event) => marginEvents.push(event), breakoutMarginCents: 2, breakoutRangeFraction: 0.2 });
margined.setSession(session);
const marginOpen = Date.parse(session.open);
margined.reset(marginOpen);
const t0 = marginOpen + 130_000;
margined.onTrade({ timestamp: t0, price: 100.10 }, t0);
margined.onTrade({ timestamp: t0 + 1_000, price: 100.00 }, t0 + 1_000);
const marginBaseline = marginEvents.length;
margined.onTrade({ timestamp: t0 + 2_000, price: 100.11 }, t0 + 2_000);
assert.equal(marginEvents.length, marginBaseline, 'a 1c excess over a 10c range does not clear a 2c floor');
margined.onTrade({ timestamp: t0 + 3_000, price: 100.12 }, t0 + 3_000);
assert.equal(marginEvents.length, marginBaseline, 'the 1c print raised the window high to 100.11, so 100.12 is again only 1c');
margined.onTrade({ timestamp: t0 + 4_000, price: 100.15 }, t0 + 4_000);
assert.equal(marginEvents.length, marginBaseline + 1, 'a 3c jump over a 12c range (2.4c margin) clears');
assert.deepEqual([marginEvents.at(-1).direction, marginEvents.at(-1).excessCents, marginEvents.at(-1).rangeCents, marginEvents.at(-1).marginCents], ['CALL', 3, 12, 2.4]);
margined.onTrade({ timestamp: t0 + 5_000, price: 100.60 }, t0 + 5_000);
assert.equal(marginEvents.length, marginBaseline + 2, 'a 48c excess clears');
margined.onTrade({ timestamp: t0 + 6_000, price: 100.70 }, t0 + 6_000);
assert.equal(marginEvents.length, marginBaseline + 2, '10c excess over a 60c range (12c margin) does not clear');
margined.onTrade({ timestamp: t0 + 7_000, price: 100.84 }, t0 + 7_000);
assert.equal(marginEvents.length, marginBaseline + 3, '14c excess over a 70c range (14c margin) clears');
assert.equal(marginEvents.at(-1).marginCents, 14);
margined.onTrade({ timestamp: t0 + 8_000, price: 99.80 }, t0 + 8_000);
assert.equal(marginEvents.at(-1).direction, 'PUT', 'the margin applies symmetrically to the downside');
assert.equal(events.at(-1).marginCents, 0, 'default signal reports a zero margin');
for (const invalid of [-1, NaN, '2']) assert.throws(() => createSignal({ onBreakout: () => {}, breakoutMarginCents: invalid }), RangeError);
for (const invalid of [-0.1, 1, NaN]) assert.throws(() => createSignal({ onBreakout: () => {}, breakoutRangeFraction: invalid }), RangeError);
console.log('signal margin check passed');
