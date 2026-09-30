# Post-exit quote evidence

The PAPER/LIVE runner writes post-exit observations under the selected account's `state/{paper|live}-accounts/<accountHash>/post-exit-evidence/` directory. Each confirmed SELL execution gets its own JSONL file, identified by an opaque window ID. Rows carry mode, account hash, trade/entry/exit execution IDs, option symbol, and entry/exit timestamps when known. Missing identity is retained as unknown and marks the window partial; windows are never joined by symbol alone.

## Capture window

The 30-second observation window starts when the runner receives the actual `position_exit` execution event. Its duration and 100 ms sampling cadence use the runner's monotonic receipt clock. This is distinct from `exitTimestampMs`, which is the broker execution timestamp; both broker source time and local quote receipt times are retained. The worker accepts the first eligible quote after 30 seconds within a one-second boundary grace period, then closes the window. It records received OPRA quotes as observed, without interpolation.

The strategy's existing T+10 grace and anchor are entry-fill-relative. Evidence retains entry and exit timestamps so later analysis can state which reference it uses. These rows do not change strategy behavior or assert a strategy horizon. A historical T+30 reference has not been established.

## Reading coverage

Each file contains `POST_EXIT_START`, zero or more `POST_EXIT_QUOTE` rows, optional `POST_EXIT_GAP` rows, and normally a `POST_EXIT_END` row. Quote rows preserve bid/ask, source timestamp, receipt wall and monotonic times, source ordering, stale/source-before-exit flags, and whether the quote is the boundary sample. `POST_EXIT_END.status` is `complete` only when the elapsed window has at least one attributable quote, a boundary sample, and no known gap. This means the capture conditions were met; it does not establish continuous market-data coverage or a quote at an exact timestamp. Partial status, a gap row, missing `POST_EXIT_END`, out-of-order or stale source times, and absent quotes must remain visible in downstream analysis.

The observer is non-authoritative: quote dispatch to the trading runtime occurs before evidence enqueue, and evidence processing never gates orders or extends the session. The observer uses a bounded 2,048-row queue, up to 256 active windows, a 350-quote per-window limit, and one sample per 100 ms. Queue loss, sampling-cap exhaustion, incomplete identity, missing quotes/boundary sample, and shutdown before the window ends produce partial evidence when persistence remains available. Source timestamps are not replaced with receipt timestamps.

## Retention and limits

Evidence files are separate from rotating telemetry and scoped to one mode/account directory. The active post-exit worker targets whole-file retention of 30 days with a 1 GiB total cap; it removes expired files and rejects new rows rather than evicting unexpired evidence when the cap is reached. The cap is sized for the next observed-scale session, not a guarantee of 30-day retention under sustained volume or storage failure. A capacity or disk error can prevent a gap/end row from being written; a missing end is incomplete evidence, and loss accounting cannot be guaranteed when persistence itself fails.

The regular `post_exit_evidence_status` telemetry row reports the observer's queue counters before shutdown flush. It is not proof that all queued rows reached disk. Worker failure, bounded shutdown, process termination, disk errors, or queue drops can leave windows incomplete. Treat the evidence as observed local capture, not broker reconciliation or proof that every quote was received.
