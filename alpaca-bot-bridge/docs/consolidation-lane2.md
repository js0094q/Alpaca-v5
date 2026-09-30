# Lane 2: PAPER runtime observability

The bot tools expose no `mode` input and bind every broker read to the configured V5 PAPER account through `paperRequest`. `bot_active_state` combines the current broker position/open-order/fill reads with retained per-fill continuity state. Entry ownership joins use the continuity `executionId` to the broker fill `id`, then the fill's `order_id` to a BUY order `id`; the BUY `client_order_id` is returned as `tradeSetId`. Latched SELL evidence joins by exact broker order ID or client order ID. Unmatched or paginated evidence stays `unknown`, `not_in_recent_fill_page`, or `not_found`; the local continuity record remains explicitly reporting-only.

The runtime also reports process/scheduler state, today's calendar session, current-session ledger records, bounded telemetry and errors, legacy PAPER history with account ownership marked unverified, and mode/account-scoped post-exit windows with coverage and paging. It does not start or poll a bot. The existing scheduler remains untouched. No duplicate BUY/SELL execution path is implemented here.

`assertBotStopped()` is an observation guard for bridge manual-order integration. `acquireTradeAuthority(role, { lockPath })` provides the shared exclusive lock at `state/v5-trade-authority.lock` for manual bridge operations and a V5 session. Lock files contain PID, role, random owner token, and acquisition time. Release removes only the caller's matching lock. Existing locks fail closed and require operator recovery; automatic stale-lock reclamation is intentionally absent because a dead-PID check followed by unlink is racy between contenders.

## Evidence

- Focused check: `node runtime.check.mjs` passed, including mode-free bot schemas, actual local process/scheduler inspection, exact fill/order joins, lock exclusion/release, and post-exit paging.
- Actual local process read on 2026-09-27: `bot_status` returned PAPER `running: false`, no PID or direct V5 processes, process scan available, scheduler loaded and idle, and state `stopped`.
- Actual local scheduler record read: `state/paper-launch-status/last-result.json` contains `status: failed` and `errorCode: 23`. The record does not establish a current runtime failure or explain the code by itself.
- Evidence level: the code and focused behavior checks are established; current process/scheduler and last-result values were read locally. No current broker account, fill, position, or order read was performed during this lane, so current trading exposure and fill ownership remain unknown until `bot_active_state` successfully reads the bound PAPER account.
