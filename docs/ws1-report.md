# WS1 SIP signal and session

## ELI5

After startup or reconnect, the signal waits 30 seconds while remembering eligible SPY trades. It then compares each new trade with the eligible trades from the preceding 30 seconds. A price strictly above that range emits `CALL`; a price strictly below it emits `PUT`; equal prices do nothing. Signals are accepted only after the session open plus two minutes, before 15:30 Eastern, and while the supplied calendar session is open.

## Exact API

```js
const signal = createSignal({ onBreakout: ({ direction, timestamp, spyPrice }) => {} });
signal.reset(nowMs);
signal.onTrade({ timestamp: isoTimestamp, price }, nowMs);
signal.setSession({ date, open, close });
```

`open` and `close` accept ISO timestamps or millisecond values. `nowMs` accepts a millisecond value or ISO timestamp. `onBreakout` receives `{ direction: 'CALL' | 'PUT', timestamp, spyPrice }`.

## Files and check

- `signal.mjs`: native Node ESM signal, rolling range, warmup, and session gates.
- `signal.check.mjs`: one small runnable assertion check for the approved rules.

Command: `node signal.check.mjs`

Verification: NOT RUN (per task boundary). The check covers warmup collection and reconnect warmup, strict equality, PUT and CALL breakouts, the 09:32 ET entry boundary, and 15:30 ET suppression.

## Unresolved items

SIP eligibility and source ordering are deliberately outside this module. The caller must provide already-eligible trades. This implementation does not choose or claim an exact SIP eligibility predicate, inspect a retired source, or claim live SIP integration is complete. The prior range uses source timestamps strictly before the triggering timestamp; out-of-order handling remains paused because it would materially change the rolling range.
