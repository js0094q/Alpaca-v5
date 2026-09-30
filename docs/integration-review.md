# V5 integration review — 2026-09-21

Status: partial local implementation; NOT deployed, NOT live-PAPER validated, NOT a completed V5 bot.

Authority: Notebook project `6d36bb46-bc94-426e-aab0-fe71535ac969`, governance decision `ca531975-3bac-4da2-8763-778f9407ad94`. User approved staggered Luna dispatch. All four approved workstreams were dispatched; Luna wrote substantive code. Astra defined interfaces, reviewed drafts, returned contract defects for correction, and ran the checks.

## Observed verification

The parent ran these focused checks successfully using Node v26.8.2:

- `node signal.check.mjs`
- `node entry.check.mjs`
- `node positions.check.mjs`
- `node runtime.check.mjs`

The runtime check uses the actual signal, entry, and position modules with a simulated broker. It verifies startup BUY cancellation blocks entry until cancellation confirmation, fresh observation, BUY quantity 3, confirmed per-contract fills, profit arming and three SELL quantity-1 orders, confirmed exits, cooldown at 4,999 versus 5,000 milliseconds, and a second BUY cycle.

This is focused local evidence, not proof of actual Alpaca order acceptance, live feed behavior, restart restoration, or trading-day rollover. No real broker orders were sent. No runtime was deployed or left running.

## ELI5

`signal.mjs` remembers already-eligible SPY prices during the 30-second observation period. Once the session permits entry, a strictly higher or lower price signals the corresponding direction.

`entry.mjs` checks ATM and one fallback option, attempts three contracts at the ask within the frozen cap, forwards actual confirmed fills, and cancels the unfilled BUY remainder on the approved clocks.

`positions.mjs` gives every filled contract its own entry price and profit floor. Accepted bids arm or raise protection, or permanently trigger SELL. Confirmed SELL fills reduce only that trade's owned quantity.

`runtime.mjs` connects these pieces, tracks interrupted startup BUY cancellations, and permits another cycle after ownership is gone and the cooldown is complete. Its inputs still require an authoritative calendar and contract/quote providers. `alpaca.mjs` implements the PAPER REST order boundary and decoded trade-update normalization; it is not a live-feed transport.

## Unresolved decisions and incomplete work

- SIP eligibility and source-ordering policy have not been approved precisely. The signal module consumes already-eligible trades; no accept-all filter or retired filter was copied.
- Original per-contract entry basis and existing armed floors cannot be reconstructed from aggregate current broker positions without an approved continuity mechanism. Startup reports the unresolved ownership state instead of fabricating basis/floor values or claiming FLAT. This is an implementation blocker, not an approved replacement for normal startup management.
- An exact ATM tie is reported without selecting a direction. No tie-breaking policy was invented.
- WS4 live SIP/OPRA/trade-update transport, real calendar/contract/quote-provider wiring, complete startup restoration, day-ledger rollover, and actual PAPER validation remain incomplete. The passing replay does not complete those requirements.

The build remains paused at these boundaries. No new strategy, continuity policy, eligibility filter, or live readiness is approved by this report.
