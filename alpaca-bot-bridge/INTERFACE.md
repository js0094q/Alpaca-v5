# Alpaca Bot Bridge interface

The public bridge tools are bound to the configured V5 PAPER account and have no mode selector. The broker layer resolves PAPER credentials from `~/Documents/paper.env`, checks the authenticated account against `PAPER_ACCOUNT_ID`, and has no LIVE route.

`request(path, options = {})` returns `{ ok, status, request, data, error? }`. `brokerSnapshot(context = {})` returns the account, orders, open orders, fills, positions and page-limit indicators for the bound PAPER account. `context` is an internal test/injection surface, not an account selector.

Read tools use GET. Three separately guarded manual tools submit, cancel, or replace a PAPER order. They require provenance `BRIDGE_MANUAL`, V5 stopped, and the shared trade-authority lock. V5_AUTO does not use them. There are no bot lifecycle or strategy-control tools.

Broker fills are matched to V5 ledger events by exact execution identifier, symbol and side. Alpaca activity IDs may have a timestamp prefix; only a UUID suffix match is normalized. Price or time proximity never establishes a fill. Local trace lineage explains signals, candidates, thresholds and decisions but does not establish broker execution.

The public evidence tools are `broker_reconcile` and `broker_trade_evidence`. The latter requires an exact V5 `tradeId` and optionally accepts a bounded date/file/offset for retained trace history. It includes per-lot and set-level realized USD P&L only when exact broker fills, lot quantity and Alpaca `contractSize` metadata support the calculation. It joins post-exit windows by exact account, trade, entry and exit identifiers. Missing facts remain Unknown; these reports never gate trading.
