# WS2 entry implementation

`entry.mjs` exposes `createEntry({broker,getContracts,getQuote,onFill,onState,nowMono})`.

- `onBreakout({direction,timestamp,spyPrice})` selects the unique nearest ATM contract when its OPRA spread is at most `0.02`; otherwise it checks exactly one adjacent OTM contract in the breakout direction with spread at most `0.05`.
- It submits exactly three contracts as a BUY, using the current ask capped at the frozen initial midpoint plus `0.03`.
- `tick()` is intended to run every 500 ms. It replaces only when the ask changes and remains within the frozen price cap; wider quotes leave the working order unchanged. It cancels an unfilled remainder at the immutable no-fill deadline or the post-first-fill five-second deadline.
- `onOrderUpdate(update)` treats broker confirmations as authoritative, forwards each confirmed contract fill immediately, and preserves order identity across replacements.

The focused check is `entry.check.mjs`; it covers the one-OTM rule, dispatch timing, cap handling, fill deduplication, cancellation, and re-entry after confirmed cancellation. It was not run here per task instructions. Ambiguous ATM ties and missing eligible quotes abandon that breakout; call `ready()` after a broker-confirmed terminal order state before accepting the next breakout.
