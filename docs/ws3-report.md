# WS3 position and sell execution

`createPositions({ broker, onExit, onState, nowMono })` returns `onFill(fill)`, `onQuote(quote)`, `onOrderUpdate(update)`, `getTrades()`, and `restoreTrade(state)`.

Each accepted entry fill creates one owned contract keyed by `tradeId`, including multiple fills sharing one BUY execution. Protection arms at entry + .05 and upgrades to entry + .08; the quote that arms a floor cannot sell against that same quote. A later accepted bid at or below the floor sells. A bid at entry + .10 sells immediately, and a bid at or below 90% of entry sells before protection. There are no peak, trailing, time, SPY, or session exits.

Once latched, one logical sell identity owns the contract. Orders submit at the latest usable bid and replace toward that bid. Partial fills reduce `remainingQty`; a confirmed full fill leaves the trade at zero and cannot resell it. Updates route by SELL `orderId` or `clientOrderId`, deduplicate SELL executions, and emit the SELL execution ID with the actual fill price. Old order IDs remain mapped, so a winning original fill during a rejected replacement is still credited once.

Verification: `positions.check.mjs` contains one representative runnable check covering floor arming, logical order identity handling, and fill accounting. Execution was intentionally left to the parent task.
