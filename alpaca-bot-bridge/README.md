# Alpaca Bot Bridge

The bridge is the bounded V5 monitoring and manual-order surface for the configured PAPER account. Broker account, orders, fills and positions provide execution evidence; local continuity, ledger and telemetry explain V5 decisions. Retained quote data is sampled market evidence and never an executable fill. Missing or incomplete facts remain Unknown.

Public tools have no account-mode selector. Broker access is pinned to `PAPER_ACCOUNT_ID`; there is no LIVE route or automated V5 lifecycle/strategy-control tool. Three manual order tools remain available for explicitly identified `BRIDGE_MANUAL` actions. They require the V5 process to be stopped and the shared trade-authority lock; their effects do not belong to V5_AUTO. The tools never silently fall back to LIVE.

Post-exit evidence records actual sampled OPRA option bids for up to 30 seconds and labels incomplete windows; it does not claim complete quote history. Reconciliation and evidence readers are observational and do not gate trading.

Run `node index.mjs` for stdio MCP. The installed local plugin and existing external tunnel point to this source. The connector-only tunnel supervisor monitors that tunnel and does not call broker or bot tools. Existing verification documents describe the state observed at their stated dates; consult `MONITORING-REPORT.md` for the most recent recorded runtime evidence.
