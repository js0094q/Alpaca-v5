# V5 read-only monitoring — integrated implementation report

Verified September 27, 2026, approximately 11:31–11:38 ET.

The canonical surface is **Alpaca Bot Bridge**, now restricted to 34 read-only tools. The existing bridge was locally editable and already implemented explicit account modes, V5 file bindings and a remotely compatible MCP transport. Extending it avoided another provider implementation. The same source serves the local Codex plugin and the external tunnel.

**Result:** implementation and available read flows are verified. Full historical post-exit acceptance remains limited by absent retained post-exit files. The connector reports that absence; it does not fabricate quotes or launch trading to produce them.

## Exact registration and supervision

| Item | Observed value |
|---|---|
| Canonical source | `/Users/josephstew/The-Final-Trading-Bot-V5/alpaca-bot-bridge` |
| Entrypoint | `/opt/homebrew/bin/node /Users/josephstew/The-Final-Trading-Bot-V5/alpaca-bot-bridge/index.mjs` |
| Local plugin ID | `alpaca-bot-bridge@personal`, version `0.2.0`, installed and enabled |
| Plugin source | `/Users/josephstew/plugins/alpaca-bot-bridge` |
| Installed plugin | `/Users/josephstew/.codex/plugins/cache/personal/alpaca-bot-bridge/0.2.0` |
| MCP server key | `alpaca_bot_bridge`; wrapper points directly to the canonical entrypoint |
| Personal entry | `/Users/josephstew/.agents/plugins/marketplace.json` |
| Tunnel alias | `alpaca-bot-bridge` |
| Tunnel ID | `tunnel_6ab840fdf5e08191bbadd06feb50717a` |
| Tunnel profile | `/Users/josephstew/.config/tunnel-client/alpaca-bot-bridge.yaml` |
| Tunnel operator plugin | `tunnel-mcp@debug` |
| Connector LaunchAgent | `com.openai.tunnel-client.alpaca-bot-bridge` |
| LaunchAgent file | `/Users/josephstew/Library/LaunchAgents/com.openai.tunnel-client.alpaca-bot-bridge.plist` |
| Supervision | On login and every 60 seconds, `supervise-tunnel.py` checks only this tunnel and reconnects it through native managed runtime commands if unavailable |
| Current supervision evidence | Agent loaded, last exit code 0; managed tunnel running; health and readiness HTTP 200; successful control-plane poll observed |

The initial app-tool reconnect failed because its environment lacked the existing Keychain-backed runtime key. The supervisor reads that key into memory and supplies only an environment reference to native tunnel-client. Credentials were not copied into source or configuration. Login configuration is loaded, but an actual reboot/login cycle was not performed. The Mac must be available for its local connector to answer. A fresh Codex thread picks up the newly installed plugin; remote tunnel calls already succeed independently of local plugin discovery.

## What changed and what was superseded

- `broker.mjs`: reused existing mode/credential routing and read envelopes; removed all broker mutation tools and mutation helpers; rejected non-GET requests and bodies before credential lookup/network access; added latest stock trades, historical SIP bars/quotes/trades and supported historical option trades. SIP/OPRA current reads cannot silently switch to other feeds.
- `runtime.mjs`: removed bot start/stop/restart and test-execution surface and runner implementation; reused existing process, continuity and ledger readers. Added active-state provenance/mtime, current errors, paged historical trace reads, and actual account-scoped post-exit evidence reads. Local account/calendar reads use the shared broker request layer.
- `reconcile.mjs`: retained the existing read-only reconciliation and added exact execution links plus `broker_trade_evidence`. Trade IDs, execution IDs, broker order/client IDs, run-scoped signal IDs and retained exit decisions can be joined without treating time/price resemblance as execution proof.
- `server.mjs` and `config.mjs`: read-only annotations and mutation-name rejection; clear evidence semantics; centralized response redaction while retaining non-secret pagination cursors.
- Focused bridge checks, connector supervision checks and current documentation were updated/added. The plugin is only a registration wrapper; it contains no second provider.

The former mixed read/write Alpaca Bot Bridge catalog is superseded by this read-only catalog. Older Alpaca Local Chat/Local Only/Read Only services were **left untouched** and are superseded only as the recommended V5 monitoring route. No locally editable source was established for the named **Alpaca Read Only – Current** hosted app, so it was not patched. Other services and trading LaunchAgents were not changed. Earlier September 26 bridge reports remain historical; this report and README describe the current interface.

## Fresh external verification

Verification used actual OpenAI Responses API MCP calls through the exact tunnel, not only imports or local catalog discovery. An unfiltered discovery request with tool execution disabled returned all 34 tools; subsequent calls used explicit read-only allowlists. The saved raw responses contain the tool outputs used below.

| Acceptance item | Result |
|---|---|
| Remote/ChatGPT-compatible path | PASS: external MCP discovery and tool execution completed through the exact tunnel |
| PAPER account | PASS: HTTP 200, explicit `paper` request mode |
| PAPER positions/orders/fills/history | PASS: 0 positions, 0 open orders, 42 historical orders, 33 broker fill activities, 48 local ledger FILL/EXIT rows |
| Runtime and active-state read | PASS: PAPER and LIVE processes observed stopped; current local state-file absence is explicit |
| Telemetry/errors | PASS: retained Sep 25 trace and historical broker/sell error records readable; current account telemetry missing |
| Dedicated post-exit evidence | LIMITED: reader/coverage/paging and mode isolation pass fixture checks; no retained account-scoped POST_EXIT files exist to verify a historical real window |
| SPY SIP latest | PASS: latest quote and trade HTTP 200; timestamps are from the prior session, not fresh Sunday trading |
| SPY SIP history | PASS: bars, quotes and trades HTTP 200 for Sep 25 19:04:50–19:05:50 UTC; pagination preserved |
| OPRA current | PASS: active SPY260928C00772000 contract confirmed; latest option quote and trade HTTP 200 |
| Option transaction history | PASS: SPY260925P00771000, same Sep 25 minute window, 100 transactions returned with a next-page cursor |
| Clock/calendar | PASS: closed Sunday; next open Monday Sep 28 at 09:30 ET; calendar read succeeds |
| Reconciliation example | PASS: exact local lot, signal, entry set, entry fill/order, sell decision and exit fill/order linked |
| Mutation discovery | PASS: no broker mutation, bot lifecycle, scheduler mutation or test-execution tool in canonical catalog |
| PAPER/LIVE isolation | PASS: both account reads succeeded with distinct identities; invalid/missing modes rejected; global PAPER trace history excluded from LIVE |
| No verification mutations | PASS: only GET broker paths; no bot lifecycle calls; before/after PAPER orders, fills, positions and open orders are identical |
| Trading behavior preservation | PASS: all 106 baseline V5 files outside the bridge remained byte-identical; existing V5 runtime replay check passed unchanged |
| Startup/supervision | PASS for installed/loaded configuration and current runtime; actual reboot recovery not exercised |

The first remote historical-option request exposed an unsupported `feed` query parameter and returned HTTP 400. It was removed, a focused regression check was added, the connector alone was reloaded, and the external read then returned HTTP 200. No supported historical option-quote endpoint was established; the connector does not advertise one. Option transactions must not be interpreted as executable historical bids.

Overall `broker_reconcile` correctly returns **unknown**, despite 48 matched ledger rows, because complete current continuity/account-scoped telemetry is absent. Flat broker positions are not proof of complete local-state reconciliation.

## A verified joined example

For `SPY260925P00771000`, local lot `0d18c285-c991-4c4d-a82b-839de9eabd33:1`:

- Retained signal: `signal-1`, scoped to run `a62bb838-f22b-483a-9f1b-5a60c6977ebd`, PUT breakout at 2026-09-25 19:04:54.997761861 UTC, SPY 770.54.
- Entry set / broker client order: `v5-buy-dc0d4c62-e5ed-4742-a815-804fb9a585ac`.
- Entry order: `b8f955a6-bada-4244-b353-0d5f6036d44d`.
- Entry execution: `0d18c285-c991-4c4d-a82b-839de9eabd33`; broker activity `20260925150455340::0d18c285-c991-4c4d-a82b-839de9eabd33`, price 0.73. That broker execution covers 3 contracts; the displayed local lot is 1 contract, not another 3-contract fill.
- Retained exit decision: `sell_latch`, reason `loss_trigger`, with subsequent retained sell-request/replacement records.
- Exit execution: `26f35d0d-c72a-4b07-97b1-48e9432a334a`; broker order `85f30a3d-4d2d-43d0-875d-d6196358602a`, one contract at 0.66, 19:05:40.946436 UTC.

This proves the historical join; it does not validate a present-day strategy or model a counterfactual fill. Missing active-lot or post-exit records remain unknown.

Reproduce through `broker_trade_evidence` with `mode: paper`, the lot ID above, `date: 2026-09-25`, and `file: v5-trace-1790363055401-a62bb838-f22b-483a-9f1b-5a60c6977ebd-000000.jsonl`.

## Final tool catalog

Every `broker_*` and `bot_*` tool requires explicit `mode: paper | live`. Default monitoring intent is PAPER; callers still pass it explicitly. Repository tools are mode-neutral and bounded. All tools carry read-only annotations.

**Broker and market**

- `broker_account` — Read account details for the explicitly selected mode.
- `broker_orders` — Read orders with supported status, date, symbol, side, and pagination filters.
- `broker_order` — Read one order by order ID.
- `broker_fills` — Read fill activities with supported date, order, and pagination filters.
- `broker_positions` — Read all open positions.
- `broker_position` — Read one open position by symbol or asset ID.
- `broker_option_contracts` — Search option contracts by underlying, expiry, type, and strike filters.
- `broker_option_snapshots` — Read latest trades, OPRA quotes, and greeks for option contract symbols.
- `broker_option_quotes` — Read latest OPRA quotes for option contract symbols.
- `broker_option_trades` — Read latest OPRA trades for option contract symbols.
- `broker_option_historical_trades` — Read historical option trades for option contract symbols.
- `broker_stock_snapshot` — Read the latest stock trade, SIP quote, and bars for one symbol.
- `broker_stock_quote` — Read the latest SIP quote for one symbol.
- `broker_stock_trade` — Read the latest SIP trade for one symbol.
- `broker_stock_historical_bars` — Read historical SIP bars for stock symbols.
- `broker_stock_historical_quotes` — Read historical SIP quotes for stock symbols.
- `broker_stock_historical_trades` — Read historical SIP trades for stock symbols.
- `broker_clock` — Read the US equity market clock.
- `broker_calendar` — Read market calendar days, optionally bounded by inclusive start and end dates.
- `broker_reconcile` — Read-only comparison of V5 active continuity and ledger state with broker orders, fills, and positions for one explicit account mode.
- `broker_trade_evidence` — Join a local ledger trade to broker execution IDs, order/client IDs and optional retained PAPER trace signal/exit decisions. Bounded evidence only; never a trading gate.

**Bot and retained evidence**

- `bot_status` — Read the actual bridge-managed bot process status for an explicit account mode.
- `bot_active_state` — Read the retained mode-scoped local active-state file and observed process status; this is not live broker state.
- `bot_errors` — Read bounded telemetry error, failure, and issue events for an explicit mode.
- `bot_post_exit_evidence` — Read mode/account-scoped retained post-exit evidence windows with coverage and paging.
- `bot_logs` — Read bounded local telemetry and ledger logs for a selected mode.
- `bot_session` — Read today’s Alpaca calendar session for an explicit mode.
- `bot_recent_trades` — Read recent local ledger fill and exit records for an explicit mode.
- `bot_history` — Read bounded historical PAPER trace events, entry and exit identifiers, sampled quotes, and coverage for a date or trace file. Legacy traces have unverified account ownership.
- `bot_session_summary` — Summarize today’s local ledger events for an explicit mode.

**Repository reads**

- `repo_status` — Read the V5 repository status.
- `repo_diff` — Read a bounded V5 source and documentation diff.
- `repo_read` — Read one bounded allowlisted V5 source or documentation file.
- `repo_search` — Search allowlisted V5 source and documentation files with bounded results.

## Checks, evidence and remaining limits

Passed: bridge `broker.check.mjs`, `runtime.check.mjs`, `integration.check.mjs`, `foundation.check.mjs`; `supervise-tunnel.check.py`; plugin validation and installed/enabled readback; LaunchAgent plist validation; existing V5 `runtime.check.mjs` replay. The post-exit fixture check uses an isolated temporary file, not fabricated historical trading evidence.

Evidence directory: `/Users/josephstew/Documents/Codex/bridge-5H7vPB`:

- `monitoring-verification/{catalog,snapshot,market,history,errors,market-history}.json`: actual external Responses API outputs.
- `final-tool-catalog.json`: complete current schemas.
- `broker-read-only-verification.json`: unchanged before/after broker state.
- `trading-source-preservation.json`: 106 unchanged baseline files.
- `tunnel-health-final.json`: health/readiness/control-plane poll result.
- `credential-scan.json`: no configured broker/API credential values found in scanned source, plugin and evidence files.

Retained reads are bounded and return truncation/cursors. Global historical traces carry unverified account provenance until exact execution evidence establishes a link. Active-state reads are retained files with mtime plus observed process status, not an in-memory debugger. The current PAPER continuity and dedicated post-exit files are absent. Historical quote paths cannot be reconstructed from transactions. No bot run, trading order, strategy modification, trading scheduler change, or ongoing broker polling was started.

**ELI5 for Joseph:** this is a read-only window into the bot. You can ask whether it is running, what Alpaca actually owns or filled, what the bot wrote about a trade, and what SPY/options data surrounded it. For retained trades, the connector can follow the receipt numbers from signal to buy to sell. It cannot press the trading buttons. If a recording is missing, it says so rather than filling in the blanks.
