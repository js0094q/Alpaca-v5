# V5 change: daily max-loss now trails the day's realized high-water mark

Status: implemented on PAPER, **not committed**. Revision 2 applies Astra's three corrections from the 2026-10-01 review (see section 6). Written by Claude (Claude Code, Opus 5.5) at the user's request.

## 1. What the user asked for
- Daily max loss = 10% of strategy capital. PAPER capital is a simulated $500, so the limit is **$50**.
- The limit is a fixed dollar amount anchored to capital. It does **not** grow with the day's gains.
- It is measured from the day's best realized result, so a $50 give-back from a peak stops new entries.

## 2. Why it changed
On 9/30 the old guard compared the day's **net** realized total against −10% of capital:
- It carried +$221 of morning 3-contract P&L across the 11:23 and 11:39 restarts (startup reset `dayStartEquity` to $500 but kept `cumulativeRealizedGross`).
- The 1-contract afternoon fell **$87 from its intraday peak** and never came close to tripping. Under the old rule it would have needed a loss of about $270.

## 3. Behavior now
| Realized P&L path today | Entries stop at |
|---|---|
| Losses from the open | −$50 |
| Up $100 at best | +$50 |
| Up $130 at best | +$80 |

- The peak starts at $0 and only rises. Trip condition: `peak − cumulative ≥ 10% × capital`, in integer cents, with equality tripping.
- **The budget is frozen at DAY_START:** 10% of the capital used to establish the day (`dayStartEquity`). A restart with different capital does not change today's budget. New capital takes effect on the next trading date.
- **Legacy same-day state** (no `peakRealizedGross`, at least one completed buy) blocks further BUYs for that date rather than guessing a peak.
- **A tripped state restored at startup writes one `DAILY_LOSS_LIMIT_RESTORED` ledger line:** peak, realized, limit, `entriesBlocked: true`, and `reason: legacy_state_without_peak` when that rule applied.
- Unchanged: the trip is sticky for the rest of the session date, blocks only new BUYs (owned contracts and SELLs are unaffected), and is persisted and restored on a same-day restart. A new date starts fresh.
- The trip now uses `DAILY_MAX_LOSS_RATE`. The old code hard-coded 10% as `* 1_000 >= * 100` in two places, so the constant drove only the ledger display.

## 4. Code changes (4 files, +99 / −25)
- `runtime.mjs`
  - New `tripDailyLoss()` helper (~line 83). It is the only trip path, used both after each completed buy and at startup.
  - `establishDailyLoss` initializes `peakRealizedGross: 0`.
  - The `DAILY_MAX_LOSS` ledger line now also records `peakRealizedGross`, and `threshold` is the trip level (`peak − limit`).
  - Startup no longer overwrites a restored `dayStartEquity` with `strategyCapital` (frozen budget). It applies the legacy-state block, runs the trip check, and writes `DAILY_LOSS_LIMIT_RESTORED` when the restored state is tripped.
- `continuity.mjs`: `validDailyLoss` accepts an optional `peakRealizedGross ≥ 0`. State files written before this change still load.
- `daily-loss.check.mjs`: new cases for a $49.99 give-back from +$100 (no trip), an exact $50 give-back (trip), −$50 from the open (trip), a profit/dip/profit run (no trip), and legacy state blocks BUYs and writes the restored ledger line (Astra's +$100 → +$25 example), a restored trip writes exactly one ledger line, and a mid-day capital change to $1,000 keeps the $50 budget. `aboveState` now carries an explicit peak. The next-day baseline assertion now includes `peakRealizedGross: 0`.
- `sizing.check.mjs`: `deepEqual` expectations updated for the new field. The restore case now expects the DAY_START baseline to be preserved rather than replaced by the configured $500.

All 13 check scripts pass: positions, continuity, runtime, loss-pause, daily-loss, sizing, sell-execution, entry, lifecycle, liquidation, and telemetry decision-parity, post-exit and durability.

## 5. Deployment
- 08:03 ET 10/1: stopped the pre-open `market-open.mjs` process (pid 9999), which had imported the old `runtime.mjs` at 07:39. Restarted it with `launchctl kickstart` (new pid 22204).
- At the time of the restart there was no `2026-10-01.claim` and no open positions, so no claim or ownership state was affected.

## 6. Review resolution (Astra, 2026-10-01)
1. **Legacy-state seeding:** fixed. The peak is no longer guessed from current P&L. A legacy same-day state with completed buys blocks BUYs for that date.
2. **Startup trip had no ledger line:** fixed with `DAILY_LOSS_LIMIT_RESTORED`.
3. **Mid-day capital change:** fixed. The budget is frozen at DAY_START.
4. **Realized only:** kept by design. With one contract at a time, an open position can't coexist with a new BUY, and its result counts as soon as it closes.

Rule as implemented, per trading date:
```
dayPeak         = max(0, highest cumulative realized P&L)
dailyLossBudget = 10% x DAY_START strategy capital   ($50 today)
trip when cumulativeRealized <= dayPeak - dailyLossBudget
tripped stays tripped for the date; owned positions and SELLs continue
```

## 7. Open items from the 9/30 review (not addressed here)
- The deletion of `telemetry/check.mjs` is staged but not committed, and will be kept out of this commit, while `telemetry/README.md:34` still tells readers to run it. Either commit the deletion and update the README, or restore the file.
- Configuration was changed and restarted three times during the 9/30 session (10:33, 11:23, 11:39 ET). Only 11:39–15:30 (115 one-contract buys, +$29, +$0.25 per contract) is a clean sample of the current rules.
- 64 of 263 `profit_floor` exits latched with the bid below entry. The spec allows this (the floor arms at reference − $0.02), but those exits should be reported as their own category. Astra suggests renaming the reason to `trailing_floor` before using exit-reason counts to evaluate Revision 2 (not part of this change).
- The 1-minute pause works mechanically: the fastest re-buy after a losing buy was 60.5 s. Day-one evidence doesn't support its premise yet: in the 1-contract block, buys after a loss made +$51 (n=57) and buys after a win made −$10 (n=57).

## 8. Trailing floor (arm at +$0.02, floor at peak − $0.04): recommendation
Leave it unchanged for 3–5 sessions with config frozen during market hours. After each session, run `python3 tools/replay.py --rebuild` and `python3 tools/replay_sequenced.py` to compare against the old +5/+8/+10 rule on the same days, using the success criteria in the 9/29 proposal. On 9/30, trail exits averaged +$0.052 at the triggering bid and loss-floor exits averaged −$0.117. One mixed-config day can't separate the trail's effect from everything else.
