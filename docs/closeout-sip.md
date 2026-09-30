# WS1 SIP eligibility and source ordering closeout

Status: implemented and locally checked. No broker action is performed here.

`tradeEligibility(trade)` accepts only SPY SIP trade records with a positive price, valid identity/source timestamp, a supported tape (`A`, `B`, `C`, or `O`), and at least one known condition. Each condition must be valid for the tape and price-forming for an intraminute high/low; one non-price-forming or unknown condition rejects the complete trade (strictest condition wins). This follows Alpaca's documented trade schema, tape-specific condition table, and strictest-condition rule: [real-time stock data](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data) and [market-data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq).

`createSipProcessor({ onTrade, onCorrection, onCancel })` is the runtime boundary. The runtime should instantiate it once with `onTrade: (trade, nowMs) => signal.onTrade(trade, nowMs)`, `onCorrection: (change, nowMs) => signal.onCorrection(change, nowMs)`, and `onCancel: (change, nowMs) => signal.onCancel(change, nowMs)`. It should call `sip.onRawTrade(rawTrade, nowMs)` for each normalized provider event and call `sip.reset()` whenever the signal is reset/reconnected. The provider wrapper is supported: the processor reads fields from `raw.raw` when present.

`signal.onTrade` preserves RFC-3339 source time through nanoseconds, rejects ordinary source-time regressions, and uses local receipt sequence for equal source timestamps. Its rolling window is pruned using nanosecond keys. Existing gates and behavior remain: fresh 30-second warmup, session/open and 09:32 ET entry boundary, 15:30 ET cutoff, triggering trade excluded from its own prior range, strict `>` CALL and `<` PUT, equality no signal.

Active-window corrections replace the stored observation while retaining its original source timestamp; an ineligible correction removes it. Active-window cancels remove the observation. Expired or unknown corrections/cancels are ignored. Neither event type invokes `onBreakout`, and prior emitted callbacks are never reversed.

Focused checks:

```text
node signal.check.mjs
node sip.check.mjs
```

Both pass locally. The checks cover ordinary eligibility, ineligible and mixed conditions, unknown combinations, tape-specific condition semantics, duplicate identity, late ordinary prints, equal-time precision/order behavior, active correction replacement, active cancel removal, no correction/cancel signals, and the unchanged symmetric breakout.

ELI5: SIP sends SPY trades with labels. The adapter keeps only trades whose labels can legitimately set a high or low. The signal remembers the last 30 seconds in the order Alpaca says they happened, ignores late ordinary prints, and lets an in-window correction or cancel fix the remembered range. Then the old price-only rule decides: above the prior high means CALL, below the prior low means PUT, and equal means nothing.
