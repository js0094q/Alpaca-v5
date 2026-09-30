# V5 design closeout — September 22, 2026

## Design-complete
YES. Design implementation is complete; V5 is not PAPER-execution-validated.

Authority: Notebook project 6d36bb46-bc94-426e-aab0-fe71535ac969, decision 0b3f6aa2-b6f6-45f1-a219-d6dec2434389.

## Implemented
- Tape-specific SIP high/low eligibility with strictest-condition-wins and unknown combinations rejected; nanosecond source ordering, deterministic equal-time receipt order, late-print rejection, and active-window correction/cancel handling without independent signals or retroactive reversal.
- Synchronous atomic, gitignored active-state snapshot. Broker-flat clears stale state; compatible state restores each fill and protection floor; missing/corrupt/incompatible state uses persistent SELL recovery for broker-owned quantity. Existing independent open SELL identities are preserved; uncovered quantity receives one logical SELL identity.
- Exact ATM ties choose higher CALL/lower PUT. ATM spread remains <= $0.02; exactly one further OTM fallback remains <= $0.05.
- Real PAPER REST, calendar, same-day contracts, SIP, OPRA and trade_updates composed with runtime, continuity and reporting. Contract discovery corrected to Alpaca's /v2/options/contracts endpoint.
- Design-closeout broker prohibits submit/replace/cancel. Its HTTP boundary also rejects non-read methods. Credentials remain in the repository .env and process memory only.

Snapshot schema: version 1 plus trades containing tradeId, executionId, symbol, entryPrice, remainingQty, profitFloor, sellLatched, logicalSellId, orderId. Basis is null only for already-latched lost-place recovery; no price or floor is invented.

## Verification
Parent-run local checks passed:
signal.check.mjs, sip.check.mjs, entry.check.mjs, positions.check.mjs, continuity.check.mjs, runtime.check.mjs, lifecycle.check.mjs, providers.check.mjs, closeout.check.mjs.

Additional parent probes passed actual provider correction/cancel wrappers and actual runtime restart with independent floors, broker-flat cleanup, missing/corrupt recovery, and confirmed-flat cooldown. The local integrated raw-provider replay reached the blocked BUY boundary using mocked broker/data inputs. Existing full-loop replay continues to exercise BUY 3, three independent exits, FLAT and cooldown.

The final authenticated 10-second run used repository .env:
- PAPER account, positions and open orders: success.
- Alpaca calendar, same-day SPY option discovery and option REST quote: success.
- SIP: connected, authenticated, SPY subscribed; 9 actual messages delivered to runtime.
- OPRA: connected, authenticated, selected option quote subscription acknowledged; 0 stream quotes during the window.
- PAPER trade_updates: connected, authenticated, listen acknowledged; 0 events during the window.
- Relevant quote probe: SPY260922C00774000.
- Runtime: WAITING, entry IDLE, no unresolved-policy blockers. Regular session had not opened.
- HTTP requests: 10; mutation requests: 0; broker mutation attempts: 0.

The pre-market run proves real initialization, session handling and SIP event consumption. It does not claim a naturally occurring live breakout, a streamed OPRA quote, or a live BUY-boundary event. Those data-availability limitations are separate from the passing local integrated checks. No synthetic broker order was created to produce trade_updates.

An earlier bounded attempt stopped at the incorrect contract endpoint. It also sent zero broker mutations. After the correction, provider and closeout checks were rerun and the final authenticated observation completed successfully.

## Unchanged approved behavior
The symmetric strict 30-second breakout, trigger exclusion, startup/reconnect warmup, BUY 3, ask-first/frozen-midpoint+$0.03 limit, 500 ms price-only reevaluation, immutable 2-second zero-fill timer, 5-second remaining-BUY window, independent fill management, profit/loss rules, persistent SELL execution, 5-second post-FLAT cooldown, calendar/session rules, 15:30 entry cutoff and no forced liquidation remain unchanged except for the explicitly approved closeout decisions.

## ELI5
At startup the bot checks what Alpaca says it owns and its current open orders. A flat account clears old active state. With matching saved state, each owned fill resumes with its own actual cost, floor and SELL intent. Without usable saved state, it sells known owned quantity through ordinary persistent SELL recovery without guessing its cost.

During the exchange session it observes fresh eligible SPY prints for 30 seconds. New entries begin two minutes after open and stop at 15:30 ET. A price strictly above the prior 30-second high signals CALL; strictly below its low signals PUT. Equality does nothing, and the trigger is excluded from its own prior range.

It checks the nearest ATM option, resolves an exact tie toward the breakout, and checks at most one further OTM strike if needed. Once the spread qualifies, the ordinary bot attempts BUY 3 at the ask, limited by the frozen midpoint plus $0.03. Price reevaluation every 500 ms never extends the initial 2-second no-fill timer. After the first fill, the unfilled remainder gets at most 5 seconds; each actual fill starts management immediately.

Each fill uses its own entry basis: usable bid at 90% of entry triggers loss SELL; +$0.05 arms its first floor; +$0.08 raises it; a later bid at/below the armed floor latches SELL. The quote that arms a floor cannot also sell at that floor. +$0.10 triggers immediate SELL. Once latched, SELL keeps following the usable bid until broker-confirmed sold, preserving order identity and reducing only remaining quantity after partial fills. Owned quantity is never abandoned.

After all fills are flat, it waits five seconds and repeats. Calendar rollover resets the day's observation/reporting identity; an existing position is not force-liquidated at market close. During this closeout phase every order action stops at the local prohibition.

## Broker consequence
No BUY or SELL order was submitted. No deployment or background monitoring remains running.

## Remaining boundary
V5 design is complete. The next phase is first actual Alpaca PAPER execution validation.

Sources for provider semantics: [Alpaca trade-condition rules](https://docs.alpaca.markets/us/docs/market-data-faq), [raw stock stream](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data), [option contracts endpoint](https://docs.alpaca.markets/us/reference/get-options-contracts).
