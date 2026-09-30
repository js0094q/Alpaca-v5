# WS4 reconciliation

`broker_reconcile(mode)` reads the selected mode's local V5 continuity and ledger snapshots alongside broker account, order history, open orders, fills, and positions. It matches the V5 account directory by the broker account ID hash, reads only account-attributable mode trace files (ignoring historical traces whose account is unknown), follows replaced-order lineage, checks aggregate broker fills against ledger execution IDs, flags excess open SELL quantity and short positions, and resolves `UNKNOWN_OUTCOME` only with a broker order read by client order ID. It never submits, replaces, cancels, or closes orders.

Incomplete local state, failed or truncated broker responses, missing ledger/fill evidence, and unresolved uncertain BUY outcomes remain `unknown`; any observed discrepancies are still included. Broker response status and request metadata are retained in the result. BUY API error details from V5 traces remain available in `buyErrors`.

`node integration.check.mjs` passed mocked regressions for PAPER/LIVE mode routing and separate state roots, invalid/missing-mode rejection before network I/O for state-changing tools, rejected BUY error retention, uncertain BUY lookup, timestamp-prefixed Alpaca fill IDs, aggregated fills for unit-level V5 trades, replacement SELL lineage, excess SELLs, shorts and fill comparisons without continuity, exclusion of unknown-account historical traces, and incomplete evidence. `node foundation.check.mjs` passed with 34 tools advertised and no broker operation called.

The V5 runtime retains its existing 15:30 ET entry cutoff. This reconciliation change does not alter V5 strategy or admission behavior. No authenticated broker account was queried and no trading mutation was performed by these checks.
