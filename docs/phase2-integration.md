# V5 bounded provider and lifecycle integration

Authority: current user request in `phase2-request.md`, Notebook project `6d36bb46-bc94-426e-aab0-fe71535ac969`, and prior checkpoint `5d1d23ee-2e3f-4506-b387-9ed7edc745c0`. Luna implemented/investigated in four isolated file scopes with approved staggered starts; Astra reviewed and executed checks. This report supersedes the prior checkpoint only for this phase's deliverables.

## Shared boundaries

- Provider `getContracts(direction, timestamp)` and `getQuote(symbol)` match existing entry inputs. Discovery returns candidates without selecting an ATM tie.
- Calendar is explicitly loaded with `loadCalendar({start,end})`; `sessionFor(now)` synchronously returns cached actual open/close and next-date information. The caller must load the applicable date range. Runtime owns strategy times.
- Provider `connect({onRawTrade,onQuote,onTradeUpdate,onDisconnect,onStatus,optionSymbols})` returns `subscribeOptions(symbols)` and `stop()`. Raw SIP events terminate at runtime `onRawTrade`, which reports the unresolved policy. They are never silently treated as eligible.
- Option quotes route to `onQuote`, normalized broker events to `onOrderUpdate`, and an established market-data reconnection must invoke `onMarketDataReconnect`. The trusted `onTrade` input remains for already-eligible simulation events.
- No live composition/launcher is activated. No orders, live authentication, deployment, or background runtime occurred in this phase.

## Evidence and unresolved decisions

Parent verification passed: `node providers.check.mjs`, `node lifecycle.check.mjs`, and `node runtime.check.mjs`. Provider checks use schema-derived fixtures, mocked REST/socket transports, actual MsgPack encode/decode, binary JSON decoding, auth sequencing and contract pagination. Lifecycle checks combine the real calendar provider with mocked REST rows and the real runtime: waiting/open, pre-09:32 suppression and entry just after 09:32, reconnect observation, 15:30 suppression, supplied next-session rollover, readable ledger finalization and explicit blockers. The skipped date in the fixture is synthetic, not evidence of a real exchange holiday. The existing replay still proves independent exits and the 4,999/5,000 ms cooldown boundary. A test initially expected entry at 09:30:30; Luna corrected the fixture, not the strategy.

`ledger.mjs` formats dated human-readable events and a day-finalization summary through an injected output writer. Both synchronous reporting errors and rejected async writes are isolated from trading. The simulation supplies the writer; no persistent live ledger destination or running launcher was configured.

`entry.mjs`, `positions.mjs`, and `signal.mjs` retain their exact pre-phase SHA-256 hashes. No completed BUY/SELL/signal implementation was reopened. Dependencies were installed from the local cache with lifecycle scripts disabled. Nothing was exercised against an authenticated Alpaca account; the standard credential environment variables inspected were absent.

The [SIP proposal](sip-eligibility-proposal.md) separates official provider schemas/bar-condition evidence from strategy approval. Joe must approve the condition set, timestamp precision, late-print response, and correction/cancel response. No filter is implemented.

The [continuity proposal](restart-continuity-proposal.md) identifies the per-contract basis, floor, quantity and SELL identity the aggregate broker view cannot restore. Its proposed local snapshot is best effort across crashes: matching aggregate quantity/order does not prove the latest floor or latch survived. Joe must explicitly accept that limitation or leave continuity design undecided. No snapshot mechanism is implemented.

The exact ATM tie remains unresolved; no strike direction was chosen.

## Remaining boundary before real PAPER validation

V5 remains incomplete and not live-PAPER validated. Approved SIP behavior must be implemented and connected before raw market data can produce entries. Restart continuity remains blocked for broker-owned exposure, and ATM ties remain explicit pauses. Authenticated provider behavior and final live composition have not been exercised. Broker-order validation requires a separate authorized phase; this request explicitly prohibited it.

ELI5: the new pieces provide the market-data connections and the trading-day schedule. The bot can wait for the exchange, observe afresh, respect entry times, and move to the next actual session. It still refuses to guess which raw prints count or how to recover missing protection state.
