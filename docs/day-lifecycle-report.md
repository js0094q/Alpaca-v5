# Day lifecycle report

`runtime.mjs` now consumes the supplied calendar session as the authority for
open, closed, and next-session state. It waits before the actual open, starts a
fresh signal observation window at each open and after a market-data reconnect,
keeps the existing two-minute entry delay and five-second monotonic cooldown,
and suppresses new entries at 15:30 Eastern. It never liquidates positions at
close; owned positions continue through the existing position manager.

Each open trading date receives a reporting ledger identity (`v5-day-YYYY-MM-DD`)
on every runtime event, including FILL and EXIT. The previous date emits
`DAY_FINALIZE` once when its supplied session closes or the next actual session
begins. `ledger.mjs` provides the small human-readable event renderer and
finalized-day summary sink. Ledger exceptions, including rejected async writes,
are swallowed, so reporting cannot block rollover or trading.

Unresolved boundaries stay explicit: `onRawTrade` returns
`SIP_POLICY_UNRESOLVED` without forwarding a raw SIP print, startup reports
`BROKER_OWNERSHIP_UNRESOLVED` for exposed SPY options, and an entry-side
`AMBIGUOUS_ATM` pause is surfaced through `getState().blockers`. No continuity
state is reconstructed and no ATM direction is selected.

Focused check: `node lifecycle.check.mjs`. The existing approved replay remains
in `runtime.check.mjs` and is unchanged.
