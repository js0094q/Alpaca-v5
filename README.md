# The Final Trading Bot V5

V5 is a PAPER-only SPY 0DTE bot. The runtime coordinates the 30-second breakout signal, option selection and entry, and per-fill position management. Alpaca providers supply the market calendar, option contracts and quotes, SIP trades, OPRA quotes, and PAPER order updates. PAPER runs use a $500 strategy capital limit and one contract per entry; the daily entry stop is 10% of DAY_START capital measured from the day's realized high-water mark.

Account-scoped continuity and ledgers are stored under gitignored `state/paper-accounts/<account-hash>/`. PAPER credentials are loaded into memory from `~/Documents/paper.env`.

Local checks:

- `npm run check` runs the runtime check.
- `npm run check:providers` checks provider behavior with mocked transports.
- `npm run check:all` runs tracked JavaScript checks and the tracked bridge supervisor check.
