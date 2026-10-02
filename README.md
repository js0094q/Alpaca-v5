# The Final Trading Bot V5

V5 supports PAPER and a guarded local LIVE mode for SPY 0DTE. LIVE startup requires credentials from exactly `~/Documents/live.env`, an authenticated account response from `https://api.alpaca.markets`, a non-PAPER active account, clear LIVE authority, and the existing runtime guards. PAPER credentials continue to come from `~/Documents/paper.env`; PAPER and bridge tools remain bound to PAPER. LIVE has no automatic start or scheduler path. The near-close SELL escalation requirement is still unresolved, so LIVE use remains blocked.

The runtime coordinates the 30-second breakout signal, option selection and entry, and per-fill position management. Alpaca providers supply the market calendar, option contracts and quotes, SIP trades, OPRA quotes, and broker order updates. Strategy sizing remains limited to $500 capital and one contract per entry; the daily entry stop is 10% of DAY_START capital measured from the day's realized high-water mark.

Account-scoped continuity and ledgers are stored under gitignored `state/paper-accounts/<account-hash>/` and `state/live-accounts/<account-hash>/`. PAPER credentials are loaded into memory from `~/Documents/paper.env`.

To explicitly start a local LIVE run, use `npm run live`. LIVE keys are never sourced from the PAPER file or process environment. The LIVE file accepts its existing LIVE key and secret field spellings or the canonical APCA names; conflicting canonical and alias values fail closed. This command does not install, enable, or invoke an automatic scheduler.

Fill measurements retain the initial construction ask across entry replacements and record each entry fill minus that ask. Exit measurements record the first bid that latched the SELL decision and each sell fill minus that bid, along with the paired order identifiers and timestamps. Restored trades without a captured decision reference remain unknown; no value is inferred.

Local checks:

- `npm run check` runs the runtime check.
- `npm run check:providers` checks provider behavior with mocked transports.
- `npm run check:live-credentials` checks credential isolation and LIVE identity guards with in-memory fixtures.
- `npm run check:all` runs tracked JavaScript checks and the tracked bridge supervisor check.
