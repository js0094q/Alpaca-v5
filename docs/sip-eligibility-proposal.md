# V5 SIP eligibility and source ordering proposal

Status: evidence and approval only. No predicate is implemented here.

Authority: Notebook project `6d36bb46-bc94-426e-aab0-fe71535ac969`; current V5 interface says `signal.mjs` receives already-eligible trades. This proposal does not change the approved price-only, symmetric 30-second breakout.

## What Alpaca sends

For a SIP stock trade (`T: "t"`), Alpaca supplies:

- `S`: symbol;
- `i`: trade ID;
- `x`: exchange code;
- `p`: trade price;
- `s`: share size;
- `c`: an array of trade-condition codes;
- `z`: tape (`A`, `B`, or `C`);
- `t`: RFC-3339 source timestamp with nanosecond precision.

Source: [Alpaca real-time stock data](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data#trades).

Alpaca's [Market Data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq) explains how condition codes affect a provider-generated minute/daily bar. A trade may have several conditions; the strictest applicable rule controls. For example, regular sales (blank condition), reopening (`5`), closing (`6`), and cross (`X`) can update minute-bar high/low, while prior-reference (`P`), seller (`R`), contingent (`V`), average-price (`W`), qualified-contingent (`7`), odd-lot (`I`), and other codes may not. This is useful evidence about price-forming versus non-price-forming prints, but Alpaca does not say that bar eligibility is automatically the eligibility rule for this strategy.

Subscribing to trades also subscribes to corrections and cancel/errors. A correction (`T: "c"`) identifies the original trade (`oi`, `op`, `os`, `oc`) and the corrected trade (`ci`, `cp`, `cs`, `cc`); a cancel/error (`T: "x"`) identifies the trade and action (`C` or `E`). Sources: [trade corrections](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data#trade-corrections) and [trade cancels/errors](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data#trade-cancelserrors).

## Historical rule inspected

The retired local policy `work/regime-telemetry/src/bot/sip-policy.ts` used an Alpaca Market Data FAQ-derived tape-B table. It marked blank, `E`, `F`, `K`, `L`, `O`, `T`, `X`, `5`, and `6` as price eligible and marked other listed codes false; unknown or missing conditions invalidated the trade. Its decoder also treated corrections and cancels as invalidations, used nanosecond `BigInt` timestamps, and qualified trade identity with exchange plus trade ID. This is a local historical snapshot, not proof of the final V4 live configuration.

That is historical evidence only. It is not an approved V5 policy, it covers only the tape-B interpretation, and it must not be copied automatically to all SIP SPY trades.

## Smallest proposed rule, in ELI5 language

Before calling `signal.onTrade`, accept a raw SIP SPY trade only when:

1. it is a valid trade message for `SPY` with a positive finite price, a valid source timestamp, and a stable identity `(tape/exchange, trade ID)`;
2. every condition on the trade is known in the approved condition table for its tape and is marked **price-forming for this intraday range**;
3. an empty condition list or an unknown condition rejects the trade; and
4. a `(tape/exchange, trade ID)` already seen is ignored as a duplicate.

The condition table must be approved as a V5 strategy policy. For the current official FAQ, the actionable tape-B minute-bar high/low set is exactly: ` ` (blank regular sale), `E`, `F`, `K`, `L`, `O`, `T`, `X`, `5`, and `6`. The same FAQ marks the following tape-B codes as non-price-forming for minute high/low: `B`, `C`, `H`, `I`, `M`, `N`, `P`, `Q`, `R`, `U`, `V`, `Z`, `4`, `7`, and `9`. Any code not in the official tape-specific table remains unknown and rejects. This list is evidence for a proposed policy, not an automatic strategy decision. It deliberately uses no share volume, bar aggregation, indicator, or momentum gate.

For corrections and cancels, remove or invalidate the affected source trade if it is still retained. Because V5 emits an irreversible breakout callback and does not reconstruct history, this proposal recommends pausing signal evaluation and requiring a fresh 30-second warmup when a correction/cancel affects the retained 30-second window. That reset is unapproved until Joe chooses it explicitly. A correction/cancel arriving after a breakout cannot safely retract an already emitted callback without changing V5 event semantics.

## Source ordering and precision

`signal.mjs` currently uses `Date.parse`, which loses the provider's nanoseconds, and keeps only trades whose parsed source time is strictly earlier than the trigger. Two distinct SIP prints in the same millisecond therefore compare equal and neither can be prior to the other. Receipt order is also unsafe: Alpaca's stream can deliver a later-arriving message whose source time is older than a message already received.

The recommended ordering key is the raw source timestamp at nanosecond precision. `(exchange, trade ID)` may identify or deduplicate a trade, but it must not make an equal-timestamp trade become a prior observation: equal source timestamps remain excluded by the existing strictly-earlier rule. Do not sort by receipt time.

Nanosecond preservation and the response to a late source timestamp are separate decisions. Alpaca documents nanosecond source timestamps, but its public schema does not promise that WebSocket delivery order is source-time order; treating receipt/source disagreement as possible is therefore an implementation inference, not a documented Alpaca guarantee.

The smallest **ignore-late** policy would preserve the current live window and simply ignore a trade whose source timestamp is older than the latest accepted source timestamp. It cannot retroactively alter a prior range or an already-emitted breakout, but the late print is omitted from the current and future window. The materially different **reset-warmup** policy would clear the rolling window, stop producing signals, and require a fresh 30-second observation period whenever such a regression is observed. That is more conservative but changes availability and is a new V5 behavior requiring approval. A bounded reorder buffer is a third option only if Joe accepts a defined delay/watermark and the corresponding correction behavior; no buffer size is implied here.

Source precision is representational: preserving nanoseconds prevents distinct source events from collapsing into one millisecond. If Joe declines precision approval, the current millisecond behavior must remain explicitly accepted: same-millisecond prints are unordered for V5 and may be excluded by the strict prior-time test. The late-print choice remains separate either way.

## Exact future code location

After approval, the raw SIP adapter should normalize and filter trades immediately before the call to `signal.onTrade` in the future runtime/provider wiring. The signal interface itself is [signal.mjs](/Users/josephstew/The-Final-Trading-Bot-V5/signal.mjs), specifically `onTrade({ timestamp, price }, nowMs)`. That adapter would supply the approved source timestamp representation and only then call `onTrade`; the breakout comparisons and direction rules stay unchanged.

## Approval needed

Please approve these choices explicitly:

1. **Eligibility:** approve the explicit tape-B price-forming set (` `, `E`, `F`, `K`, `L`, `O`, `T`, `X`, `5`, `6`), requiring every condition to pass and rejecting unknown/missing conditions; or choose the materially narrower regular-sale-only rule (blank condition only).
2. **Precision:** preserve the provider's nanosecond source timestamp, while keeping equal source timestamps out of the prior range; or keep the current millisecond `Date.parse` behavior and accept its same-millisecond ambiguity.
3. **Late prints:** ignore a source-time regression for the current/future window; reset to fresh 30-second warmup; or approve a bounded reorder buffer with an explicit watermark/delay. This choice is independent of timestamp precision.
4. **Corrections/cancels:** reset to a fresh 30-second warmup when an affected trade is still in the retained window (the recommendation above), or choose an alternative response such as ignoring the late invalidation for signal purposes. No reset behavior is approved by this proposal alone.

No provider bar's own eligibility status is being treated as an automatic strategy decision.
