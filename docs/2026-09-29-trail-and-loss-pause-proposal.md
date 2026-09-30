# V5 proposal: trailing profit floor + 1-minute pause after a losing buy

Status: PROPOSAL, revision 2 (2026-09-30), for Astra to implement as a PAPER test once recorded as a Notebook decision. Nothing here is implemented.

Proposal offered by Claude (Claude Code, Opus 5.5) at the user's request, from read-only analysis of the 9/28 and 9/29 PAPER sessions. Revision 2 incorporates the external review of revision 1 and the user's choices on 2026-09-30: test the trailing floor; pause = 1 minute.

Replay tools (offline, no broker calls): `tools/replay.py` (exit rules per contract) and `tools/replay_sequenced.py` (sequenced, with pause and censoring bounds).

## 1. What changed from revision 1
- Pause is **1 minute**, not 5. The data only contains re-buys within 1 minute of a loss, so it cannot support a longer duration.
- Pause triggers on a set result **< $0.00** (a $0.00 set does not pause).
- Pause **survives a restart** (wall-clock `pauseUntil` saved with the existing continuity state).
- Replay numbers are redone: baseline and proposal both use reference = max(entry, anchor); a buy is skipped if the bot would still be holding or pausing; pause decisions use the simulated result of the preceding buy; trades that outlive the recorded prices are reported as unresolved with bounds, not closed at the last bid. The revision 1 figures (−$38, +$267, +$397) are withdrawn.

## 2. Rules (proposed spec text)

### 2a. Trailing profit floor (replaces the +$0.05 arm, +$0.08 re-arm and +$0.10 ceiling)
Unchanged: 10.000-second grace, immutable anchor bid, reference = max(entryPrice, anchorBid), 90%-of-reference loss floor (bid ≤ floor latches SELL), and all SELL execution rules.

- **Arm:** when a usable bid first reaches reference + $0.02, the contract becomes TRAILING. The arming quote cannot also trigger a floor SELL.
- **Peak:** the highest usable bid seen since arming.
- **Protected floor:** peak − $0.04. It only moves up.
- **Trigger:** a later usable bid strictly below the protected floor latches SELL. Equality holds.
- **No ceiling:** there is no fixed maximum-profit SELL.
- While the protected floor is below the loss floor, the loss floor still applies.
- At arming the floor is reference − $0.02, i.e. not yet a profit. This is intentional; do not clamp it to the reference.
- Supersedes the spec line "there is no moving/peak-based anchor and no peak-minus-$0.03 trailing rule" (the anchor stays fixed; only the protected floor trails).

Example (reference $1.00): bid reaches $1.02 → armed, floor $0.98. Bid runs to $1.15 → floor $1.11. Bid $1.11 → hold. Bid $1.10 → SELL latched, normal SELL execution.

### 2b. Pause after a losing buy
- A "buy" is one entry attempt's set of broker-filled contracts. Zero-fill attempts are not buys.
- When the last contract of a buy is broker-confirmed sold, compute Σ (exit fill − entry fill) × qty from broker fills.
- If the result is **< $0.00**, no new BUY may be submitted for **60 seconds** from that moment. Otherwise the normal 5-second post-FLAT cooldown applies.
- During the pause the bot keeps observing SIP. Breakouts during the pause are ignored, not queued.
- The pause never affects owned contracts, SELL execution, or the 15:30 shutdown.
- **Restart:** the pause end is kept as a wall-clock time for the current session date and honored after a restart the same day. A new trading day starts with no pause.

## 3. Evidence

### Trailing floor
30 s after each actual exit on 9/28 and 9/29: +$0.10 ceiling exits rose another 5¢+ in 72% / 69% of cases; loss-floor exits got back to entry in only 10% / 9% (so the loss floor is left alone).

Sequenced replay, 9/28–9/29, valued at the triggering bid (`python3 tools/replay_sequenced.py`):

| Rule | Buys | Resolved only | Unresolved contracts | Total, unresolved at worst case | Total, unresolved at last bid |
|---|---|---|---|---|---|
| Current +5/+8/+10 | 197 | −$535 | 74 | −$1,482 | −$793 |
| **Trail +2/−4** | 179 | −$458 | 82 | **−$382** | +$72 |
| Current + 1-min pause | 145 | +$67 | 53 | −$628 | −$135 |
| **Trail + 1-min pause (this proposal)** | 133 | −$438 | 63 | −$424 | −$98 |
| Trail + 5-min pause | 75 | −$168 | 36 | −$40 | +$95 |

"Worst case" sells every unresolved contract just under its floor (or at the loss floor if never armed). The trail's worst case beats the current rules' last-bid case, so the direction of the improvement survives censoring; its size does not (roughly $150–$850 over two days).

### Pause
- Historically, 105 buys followed a losing buy and lost $430 in total; 104 of them came within 1 minute of that loss closing. There is no data on re-buys 1–5 minutes after a loss.
- In the sequenced replay the 1-minute pause clearly helps the current rules, but adds nothing measurable on top of the trail (−$424/−$98 with the pause vs −$382/+$72 without). It is included at the user's direction as a PAPER experiment, not as a demonstrated improvement.
- Longer pauses mainly reduce trade count. Judge the pause on result per contract, not total dollars.

## 4. Code touch points (estimates)
- `positions.mjs` `evaluate()` (~lines 136-198): replace ARM_5C / REARM_8C / CEILING_10C with arm/peak/floor logic; add `peakBid` to the trade; `phase()` becomes HOLD / TRAILING / SELL_LATCHED. About −30 / +15 lines.
- `continuity.mjs`: persist `peakBid`; floor validation becomes "floor = peak − 0.04, floor ≥ reference − 0.02" instead of "delta is exactly 5 or 8"; add session-dated `pauseUntil`. About ±10 lines.
- `runtime.mjs`: tally realized result per `tradeSetId` from exit fills held in memory (the ledger is reporting, not authority); on set close set the entry block until `pauseUntil` (wall clock) when the result is < 0; record `pauseReason` on the COOLDOWN state/ledger line; restore `pauseUntil` on startup. About +25 lines.
- `telemetry/trace.mjs`, `telemetry/check.mjs`, `telemetry/decision-parity.check.mjs`: rename threshold fields to `trailArmThreshold` / `protectedFloor` / `peakBid`. About 5 lines.
- `positions.check.mjs`: replace the 8 ladder/ceiling assertions with trail cases (arming quote can't sell, equality holds, floor only rises, floor starts at reference − 0.02, loss floor wins below arm, no ceiling). About 50 lines.
- `runtime.check.mjs`: losing set → 60 s pause; $0.00 and winning sets → 5 s; zero-fill attempt → none; owned contracts still managed during pause; pause honored after restart, cleared on a new date. About 40 lines.

## 5. Validation on PAPER
- Before the first session: commit a git baseline so this change is reviewable as one diff.
- After each of the next 3–5 sessions: `python3 tools/replay.py --rebuild` then `python3 tools/replay_sequenced.py`; compare the trail against the current rule on the same recorded days.
- Keep recording bids for 30 s after exit. Report unresolved contracts separately every time.
- Success criteria to agree before the test: trail worst-case total ≥ current-rule last-bid total over the test window; pause judged on result per contract after a loss vs after a win.

## 6. Caveats
- Two sessions, ~240 buys; the 3 contracts per buy are correlated.
- Replay values are at the triggering bid, not simulated broker SELL fills (actual paper fills ran ~$400 better than triggering bids on these days).
- The replay can only re-use buys that actually happened; signals the bot never acted on have no recorded option prices.

## 7. Out of scope
Durability fixes and the simplification cuts from the same review are separate proposals and are not bundled with this change.
