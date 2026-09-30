# Workstream 3 report — runtime and mode plumbing

## Changed

- `alpaca-bot-bridge/runtime.mjs` — explicit-mode bot status/start/stop/restart, logs, session, recent trades, session summary, sanitized runtime config, fixed non-trading test suites, local account snapshot, and bounded repository status/diff/read/search tools. Process control is mode-scoped; starts serialize against any existing V5 runner. Stop disables entries and uses the existing flat-drain behavior.
- `alpaca-bot-bridge/runtime.check.mjs` and `alpaca-bot-bridge/RUNTIME-INTERFACE.md` — non-trading mode, endpoint, account-path, cutoff, and process-target checks; documented snapshot status and truncation semantics.
- V5 mode plumbing: `alpaca.mjs`, `providers.mjs`, `paper-account.mjs`, `paper.mjs`, `market-open.mjs`, `runtime.mjs`, and `package.json`. Broker and provider constructors require an explicit API URL. Legacy scheduled/package PAPER entrypoints bind `paper` explicitly. LIVE uses the LIVE Trading API and trade-update stream, separate account-scoped continuity/ledger/telemetry paths, and no PAPER credential fallback. Market-open scheduling, cutoff, and drain behavior are shared across modes.
- Updated focused caller checks: `closeout.check.mjs`, `entry-403.check.mjs`, `lifecycle.check.mjs`, `market-open.check.mjs`, `paper-account.check.mjs`, `providers.check.mjs`, and `sell-execution.check.mjs`.

## Checks

Passed: bridge runtime check, V5 runtime check, providers check, market-open check, paper-account check, closeout check, entry-403 check, sell-execution check, and `node --check` on changed runtime/mode modules.

Checks used mocked broker/provider endpoints or local fixtures. No bot was started, stopped, or restarted; no broker order or live request was submitted by these checks.

## Limits

- Actual process-control lifecycle and authenticated account/session reads remain unexercised. `bot_test` offers fixed local non-trading suites; its bridge suite does not launch a bot.
- LIVE local continuity/ledger data remains explicitly missing until a LIVE session writes it. Historical root PAPER telemetry is labeled as an unknown historical account and is not mixed with the account-scoped trace directory.
- The existing checkout is wholly untracked, so a Git diff against `HEAD` is unavailable; no cleanup/reset was performed.
