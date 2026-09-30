# Lane 1 — PAPER broker and market-data bridge

## Implemented surface

The bridge is pinned to PAPER. `config.mjs` loads the existing PAPER credentials and fixes Trading API and market-data origins; it exports expected account UUID `94c3c77c-bf58-4dbb-ac57-5a9b9e41c40b`. There is no public mode selector or LIVE profile/fallback. Broker requests reject non-PAPER credentials/origins, and verify the authenticated account identity before any route other than the initial `GET /v2/account`; that account read itself checks the expected UUID.

Broker tools cover account/buying power, positions, orders, exact order lookup/status, fills, all account activities and typed activities, portfolio history, clock/calendar, SIP stock data, OPRA latest option quotes/trades/snapshots, option historical quotes/trades/bars, and option contracts/chains. Options historical bars omit the unsupported `feed` query; live options quote/snapshot calls explicitly use OPRA.

PAPER writes are limited to whole-contract SPY option limit/day orders for buy-to-open and sell-to-close. Bridge-owned orders use `bridge-manual-` client IDs and are distinct from `V5_AUTO` order IDs. Manual mutations require the shared account trade-authority lock and a stopped-bot guard. Manual entry is rejected against pre-existing positions/open orders; manual exits and SELL quantity replacements must remain within the confirmed marker-owned position. Submit, replace, and cancel preserve broker-confirmed results and perform exact readback. Exact order lookups are broker-read-only and do not update the local ownership marker; marker reconciliation occurs only inside the already-locked manual mutation path or V5 startup. Ambiguous outcomes remain marked unknown; 404 is not treated as proof of terminal state.

The shared root module `trade-authority.mjs` supplies an exclusive `v5-paper`/`bridge-manual` lock and a small durable manual ownership marker. A marker clears only after bound-account verification, a flat/no-open-order snapshot, and terminal evidence for marker orders. While holding the shared startup lock, V5 resolves each pending marker client order ID through Alpaca's exact client-ID GET; recorded replacement successors are resolved separately before cleanup. A 404 or other unresolved result keeps startup blocked. Unknown/stale locks and unresolved manual order outcomes fail closed. V5 startup uses the same lock and marker helper.

## Evidence and checks

Observed before baseline (2026-09-27): authenticated PAPER account UUID matched `94c3c77c-bf58-4dbb-ac57-5a9b9e41c40b`; parent independently observed stopped bot/scheduler, no positions, and no open orders. Credentials were not printed or migrated.

The current authenticated account read succeeded. The parent’s current direct read probe initially found HTTP 200 for account, positions, orders, fills, all activities, portfolio history, clock/calendar, SIP, option contracts, OPRA quotes/snapshots, and discovered the options-bars `feed` parameter was rejected. That parameter has now been removed; the parent is performing the fresh external consumer read after this fix.

`node alpaca-bot-bridge/broker.check.mjs` passes. It uses a stateful mocked transport to exercise PAPER identity rejection, mode-free tools, SIP/OPRA and broker-read route coverage, manual BUY → lookup → replace successor → cancel → terminal readback, marker cleanup, marker-owned SELL to flat, rejection of unowned exposure, lock exclusion, and ambiguous POST + 404 retention. No real broker mutation is part of the test.

`npm run check` passes: 42 tools advertised and no broker operation called. Credentials and global connector/tunnel/plugin configuration were not changed. No LIVE request or broker mutation was made by this lane.

## Files

- `alpaca-bot-bridge/config.mjs`
- `alpaca-bot-bridge/broker.mjs`
- `alpaca-bot-bridge/server.mjs`
- `alpaca-bot-bridge/index.mjs`
- `alpaca-bot-bridge/broker.check.mjs`
- `alpaca-bot-bridge/foundation.check.mjs`
- `trade-authority.mjs` (shared with V5 runtime)
