# Design-closeout provider composition

`closeout.mjs` composes the existing Alpaca PAPER REST broker, calendar, 0DTE contract/OPRA quote providers, SIP raw-trade stream, OPRA quote stream, PAPER `trade_updates`, and the existing runtime. It reads only `APCA_API_KEY` and `APCA_SECRET_KEY` from the repository `.env` into process memory.

The closeout broker delegates read-only inspection and replaces `submitOrder`, `replaceOrder`, and `cancelOrder` with a hard design-closeout prohibition. Each attempted mutation is counted and rejected before any HTTP request. The runner's HTTP wrapper also rejects every non-read method and reports its mutation counter. REST failures expose only a safe failure code, never response bodies. The runner is bounded to at most 45 seconds and returns safe JSON counters for REST success, stream connection/authentication/subscription, normalized message receipt, runtime state, and mutation attempts. Runtime ledger events are sent through the existing `createLedger` sink to gitignored `state/closeout-ledger.log`.

Run the local checks with `npm run check:providers` and `npm run check:closeout`. The authorized authenticated runner is:

```sh
node closeout.mjs
```

Its output is a safe report. `authenticated` and `subscribed` are transport evidence; `messages` distinguishes actual normalized receipt. A closed or pre-open market can therefore report successful authentication/subscription with zero live qualifying messages. This runner does not claim PAPER execution validation and never submits, replaces, or cancels an order.

ELI5: the bot can now plug its real Alpaca eyes and calendar into its existing brain, while the hands are physically disconnected during design closeout. It can look at account truth, options, quotes, and streams, but any attempt to place or change an order stops locally.
