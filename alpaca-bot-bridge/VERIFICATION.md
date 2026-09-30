# Alpaca Bot Bridge — verified state, September 26, 2026

Implementation is installed and the exact tunnel is running. External Responses API catalog and operational read verification now pass using the user-supplied credential in ~/Documents/alpacaai.env. No credentials were embedded in the bridge.

## Location and tunnel

- Repository: `/Users/josephstew/The-Final-Trading-Bot-V5`.
- Bridge: `/Users/josephstew/The-Final-Trading-Bot-V5/alpaca-bot-bridge`.
- Server name: **Alpaca Bot Bridge**; stdio entrypoint `index.mjs`.
- Tunnel: `tunnel_6ab840fdf5e08191bbadd06feb50717a`, alias `alpaca-bot-bridge`.
- Native remote metadata name was changed to Alpaca Bot Bridge, preserving its organization/workspace bindings.
- Final runtime restarted after code freeze. Health and readiness HTTP200, successful control-plane poll required and observed. Local health UI: http://127.0.0.1:52464/ui (ephemeral port).
- Profile: `/Users/josephstew/.config/tunnel-client/alpaca-bot-bridge.yaml`; runtime key is an environment reference, not embedded credentials. Native daemon receives CONTROL_PLANE_API_KEY from Keychain.
- Official SDK stdio client lists34 tools. Actual Responses API mcp_list_tools through the exact tunnel returned the same34 names. Seven remote read calls then passed: PAPER/LIVE broker_account (HTTP200), PAPER/LIVE bot_status (stopped), PAPER/LIVE bot_recent_trades (actual PAPER ledger and explicitly missing LIVE history), and repo_read of actual V5 package.json.
- The working consumer credential is read only from `/Users/josephstew/Documents/alpacaai.env` for verification; it is not copied into source, tunnel configuration or logs. Earlier OpenAI/admin/control-plane credential probes lacked required permission; that blocker is resolved.
- Remote testing exposed a protocol mismatch in the SDK serveStdio router. The minimal fix uses the installed official SDK StdioServerTransport with server.connect, allowing native legacy negotiation to2025-11-25. No custom protocol translation, SDK patch, dependency change, or global configuration change. Tunnel readiness and remote invocation pass after reconnect.


## Modes and credentials

All broker_* and bot_* tools require explicit `mode: paper | live`; repository reads are mode-neutral. Missing/invalid modes are rejected before side effects. One implementation handles both modes. There is no cross-mode credential fallback or implicit PAPER mode.

| Mode | Existing credential source | Trading endpoint |
|---|---|---|
| PAPER | `/Users/josephstew/Documents/paper.env`, APCA_API_KEY/APCA_SECRET_KEY | https://paper-api.alpaca.markets |
| LIVE | `/Users/josephstew/.config/alpaca/profiles/live-rotated.yaml`, api_key/secret_key; live_trade must be true | https://api.alpaca.markets |

Market-data origin is https://data.alpaca.markets with the selected mode's credentials. Distinct account identities and credential sources were observed; both accounts authenticated successfully. Mutations preserve before-state, requested action, HTTP status, broker error/code/body, request and order/client IDs, and after-state where available. Ambiguous outcomes are not retried blindly. Partial207 errors remain errors in MCP responses.

## Authoritative runtime bindings

The shared execution path is bridge `runtime.mjs` → V5 `market-open.mjs` → `paper.mjs` → existing runtime/providers/strategy. Legacy PAPER schedule/package entrypoints select PAPER explicitly. LIVE passes resolved LIVE credentials into the same path and uses its matching trade-update WebSocket endpoint.

Existing LaunchAgent `/Users/josephstew/Library/LaunchAgents/com.josephstew.v5-market-open.plist` is unchanged and loaded, with no active bot observed. Both mode statuses return stopped from process inspection. Starts are conservatively serialized across all V5 processes. Stop disables new entries and lets existing owned-position management drain; restart requires confirmed stop. Actual process start/stop/restart was not exercised because that could activate trading. Mocked process targeting, mode routing, cutoff, and stop-entry checks passed.

State remains account-scoped: `state/paper-accounts/<account hash>/` and `state/live-accounts/<account hash>/`. PAPER hash is `9951942c1cd478426c755f52f665936e33480ec381af4502abcca53db325a7e3`; LIVE hash is `1a17f36b11e40a2bab70a6a5282a1c11dd5eb97693f20cc96949379f1c6e701a`.

Within each account directory: `v5-active-state.json`, PAPER `paper-ledger.log` or LIVE `live-ledger.log`, `market-open/` claims, and `telemetry/*.jsonl`. Bridge PID/start locks use `state/alpaca-bot-bridge/` with explicit mode names. Existing root `telemetry-trace/` historical PAPER traces are exposed separately as unknown historical account, never treated as current account truth. Current PAPER ledger has88 lines; recent-trades returned48 actual FILL/EXIT records. LIVE ledger is missing, not manufactured as empty history. Both continuity files and current account-scoped telemetry are missing. Broker reconciliation returns unknown with PAPER historical fill IDs matched; it does not infer full reconciliation from flat broker positions.

No signal, sizing, profit/loss, entry timing, or cutoff policy was redesigned. Existing09:32 entry eligibility and15:30 cutoff remain. Generic shell, arbitrary filesystem access, and repository mutation are not exposed; code edits remain through Controlled Chat Bridge/Codex. Its existing service/profile was untouched.

## Tool catalog (34)

- `broker_account`, `broker_orders`, `broker_order`, `broker_fills`, `broker_positions`, `broker_position`, `broker_place_order`, `broker_replace_order`, `broker_cancel_order`, `broker_cancel_all`, `broker_close_position`, `broker_close_all`, `broker_option_contracts`, `broker_option_snapshots`, `broker_option_quotes`, `broker_stock_snapshot`, `broker_stock_quote`, `broker_clock`, `broker_calendar`, `broker_reconcile`
- `bot_status`, `bot_start`, `bot_stop`, `bot_restart`, `bot_logs`, `bot_session`, `bot_recent_trades`, `bot_session_summary`, `bot_runtime_config`, `bot_test`
- `repo_status`, `repo_diff`, `repo_read`, `repo_search`

## Evidence and actual results

- All14 existing V5 focused checks plus4 bridge checks passed: closeout, continuity, entry-403, entry, lifecycle, liquidation, market-open, paper-account, positions, providers, runtime, sell-execution, signal, sip; bridge broker, foundation, integration, runtime. Root also reran runtime.check after final review: pass.
- Regression coverage includes rejected BUY error retention, UNKNOWN_OUTCOME lookup/reconciliation, replacement/excess SELLs, unintended shorts, missing/invalid modes, reciprocal missing-credential isolation, mode-specific endpoint/stream paths, and cutoff behavior. These are local/mock checks, not live executions of those failure scenarios.
- Actual PAPER and LIVE account, positions, orders, fills, calendar/clock, SIP stock data and OPRA option reads returnedHTTP200. Both accounts had zero positions/open orders at observation.
- Safe actual PAPER mutation: cancel-all only after verifying zero open orders/positions; HTTP207 with empty before/after state. No order was placed. Other mutation semantics were tested with mocks.
- Final official MCP stdio smoke:34 tools,37 tool calls passed, including actual both-mode reads, source inspection, fixed non-trading bot_test, and18 missing/invalid-mode mutation rejections.
- Final tunnel health with --require-control-plane-poll passed after compatibility restart. Remote catalog exact-match and7/7 read-call assertions also pass; these are external evidence, separate from local readiness.
- Exact-value secret scan over98 source/evidence/profile/log files found zero configured credential matches. Dependencies/runtime state were excluded from that source scan.
- Seven pre-existing related service/profile hashes are unchanged. No unrelated repository/service was edited. The V5 checkout had no HEAD and was wholly untracked at start; no commit/reset/stash was performed. repo_diff returns no_git_baseline honestly.

Evidence files under `/Users/josephstew/Documents/Codex/bridge-eeWlGx`: `final-tests.json`, `stdio-smoke-evidence.json`, `account-read-evidence.json`, `paper-mutation-evidence.json`, `reconcile-read-evidence.json`, `tunnel-metadata-evidence.json`, `tunnel-final-connect.json`, `tunnel-final-health.json`, `control-plane-responses-probe.json`, `secret-check-evidence.json`, `changed-files.json`, plus the preserved pretask baseline.

## Exact source files changed

Paths below are relative to `/Users/josephstew/The-Final-Trading-Bot-V5`.

Existing files:

- `alpaca.mjs`
- `closeout.check.mjs`
- `closeout.mjs`
- `entry-403.check.mjs`
- `lifecycle.check.mjs`
- `market-open.check.mjs`
- `market-open.mjs`
- `package.json`
- `paper-account.check.mjs`
- `paper-account.mjs`
- `paper.mjs`
- `providers.check.mjs`
- `providers.mjs`
- `runtime.check.mjs`
- `runtime.mjs`
- `sell-execution.check.mjs`

New bridge files:

- `alpaca-bot-bridge/INTERFACE.md`
- `alpaca-bot-bridge/README.md`
- `alpaca-bot-bridge/RUNTIME-INTERFACE.md`
- `alpaca-bot-bridge/WS1-REPORT.md`
- `alpaca-bot-bridge/WS2-REPORT.md`
- `alpaca-bot-bridge/WS3-REPORT.md`
- `alpaca-bot-bridge/WS4-REPORT.md`
- `alpaca-bot-bridge/broker.check.mjs`
- `alpaca-bot-bridge/broker.mjs`
- `alpaca-bot-bridge/config.mjs`
- `alpaca-bot-bridge/foundation.check.mjs`
- `alpaca-bot-bridge/index.mjs`
- `alpaca-bot-bridge/integration.check.mjs`
- `alpaca-bot-bridge/package-lock.json`
- `alpaca-bot-bridge/package.json`
- `alpaca-bot-bridge/reconcile.mjs`
- `alpaca-bot-bridge/runtime.check.mjs`
- `alpaca-bot-bridge/runtime.mjs`
- `alpaca-bot-bridge/server.mjs`
- `alpaca-bot-bridge/VERIFICATION.md`

Installed dependency files are confined to `alpaca-bot-bridge/node_modules/` and pinned by its lockfile. External operational additions: the new tunnel profile above, native managed runtime registry/log/health entries for this alias, and verification artifacts in the dedicated workspace. The existing remote tunnel's name/description were updated; no unrelated remote tunnel was changed.

## Remaining boundary

No implementation/remote-authentication blocker remains for this bounded delivery. Actual bot start/stop/restart and actual buy/replace/close executions were not tested against the broker; their local safety/mode checks pass. No LIVE trade or autonomous bot session was started. Missing current local continuity/telemetry is reported explicitly rather than repaired by creating duplicate state. The conservative shared process guard permits only one V5 bot process at a time across modes.

## Final remote evidence

Under `/Users/josephstew/Documents/Codex/bridge-eeWlGx`: `alpacaai-responses-probe.json` (34 remote tools), `remote-read-evidence.json` (seven successful read calls), `remote-verification-summary.json` (asserted results), `tunnel-compatible-connect.json`, and `tunnel-compatible-health.json`. Earlier failures are preserved as `remote-read-protocol-failure.json` and `remote-read-startup-failure.json`; these do not describe the final working state. Compatibility follow-up changes only existing bridge index.mjs, foundation.check.mjs and WS1-REPORT.md; no new tool or strategy behavior.

Root independently reran final foundation.check.mjs after compatibility fix: PASS, including legacy negotiation fallback, catalog, repository read and missing-mode rejection. Earlier18/18 suite results remain applicable to unchanged broker/runtime/strategy code.
