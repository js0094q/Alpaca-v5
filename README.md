# The Final Trading Bot V5

The runtime is a thin PAPER-only coordinator for the signal, entry, and position components. It starts from current account, SPY option positions, and open orders, restores compatible local per-fill continuity, and sends known unmatched exposure through the approved lost-place SELL recovery.

The real Alpaca provider composition covers calendar, same-day option discovery, SIP raw trades/corrections/cancels, OPRA quotes, and PAPER `trade_updates`. PAPER runners and the scheduled launcher read credentials from `~/Documents/paper.env` in memory. Continuity, ledgers, and launch claims live under gitignored `state/paper-accounts/<SHA-256 of broker account ID>/`; legacy state remains preserved and is never used for a new account. The design-closeout runner hard-blocks all broker and HTTP order mutations. Telemetry keeps its existing directory and retention limits.

Run focused local checks with `npm run check`, `npm run check:providers`, and `npm run check:closeout`. Run `node closeout.mjs` for bounded authenticated, non-ordering validation.
