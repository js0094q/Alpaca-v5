# V5 restart continuity proposal

Status: investigation only. This document does not implement continuity, change strategy rules, or clear the current `BLOCKED_OWNERSHIP` state.

## What Alpaca can and cannot restore

The current Alpaca position endpoint returns one current position per symbol, including option `symbol`, `qty`, `qty_available`, `side`, `avg_entry_price`, `cost_basis`, `current_price`, and live P/L fields. Alpaca says a closed position is no longer queryable. See [all open positions](https://docs.alpaca.markets/us/v1.1/reference/getallopenpositions) and the [options position example](https://docs.alpaca.markets/us/docs/options-trading-overview).

The open-orders endpoint returns the current order objects and supports `open`, `closed`, or `all` filtering. An order includes identities and lifecycle fields such as `id`, `client_order_id`, `symbol`, `side`, `qty`, `filled_qty`, `filled_avg_price`, `status`, and replacement links. See [get all orders](https://docs.alpaca.markets/us/reference/getallorders-1). Trade updates also expose a fill's `execution_id`, `qty`, and `price`, plus the order object. See [websocket trade updates](https://docs.alpaca.markets/us/docs/websocket-streaming).

That is enough to observe current aggregate ownership and current order state. It is not enough to reconstruct V5's contract records:

- `avg_entry_price`/`cost_basis` are aggregate position values, not the individual executed contract basis keyed by V5 `tradeId`/`executionId`. Multiple fills of the same option symbol cannot be split back into their original V5 records from one aggregate row.
- No current position or order field represents the V5 `profitFloor`, whether the floor was armed, or the prior `sellLatched` decision.
- An open SELL order can expose its current `id` and `client_order_id`, but no open order is not proof that no prior SELL latch existed; a filled, canceled, expired, or lost order is no longer an active order.
- Broker `filled_avg_price` is the order's aggregate fill average. It cannot replace each contract's actual entry basis without changing the approved per-contract profit and loss floors.

Therefore the broker alone cannot safely resume an owned SPY option. This is why the current runtime reports `BLOCKED_OWNERSHIP` when it sees broker-owned SPY options.

## Minimum continuity state

The smallest state needed to resume the existing `positions.mjs` evaluation is one record per V5 contract:

```json
{
  "tradeId": "...",
  "symbol": "SPY...",
  "entryPrice": 1.23,
  "remainingQty": 1,
  "profitFloor": null,
  "sellLatched": false,
  "logicalSellId": null,
  "orderId": null
}
```

These fields preserve the contract key, actual entry basis, remaining owned quantity, current protected floor, and the SELL latch/order identity needed by `restoreTrade` and subsequent order updates. `executionId` is useful reporting provenance but is not required to evaluate the contract after restart, so it is deliberately outside the minimum. Quotes, `lastProtectionQuote`, in-flight/request flags, and transient seen-ID sets are also outside the minimum; they must not be treated as recovered facts.

## Recommended minimal mechanism

With approval, store exactly an array of those records in one local file such as `state/v5-continuity.json`, owned by the V5 runtime. The proposed write boundary is synchronous from the state machine's point of view: after a broker-confirmed entry fill or SELL fill, after a floor arm/upgrade, and after SELL latch/order identity changes, complete the replacement before the next broker action (especially before SELL dispatch). A full close removes the record in the same replacement. The proposal does not claim a particular filesystem flush primitive; a crash before that replacement completes can lose the newest transition. Read it before startup decides whether broker exposure can be resumed; restore each record, then resume normal quote/order handling. A flat file is sufficient for this bounded representation; no database, Valkey, reconciliation service, or historical lineage is proposed.

ELI5: Alpaca can say “you own two of this option and your open order is here.” The file says “these are the two V5 contracts, what each one actually cost, how high its safety floor is, and whether its SELL decision was already made.” On restart, read the file first and put those contracts back into the position manager. If the file is absent, invalid, or has a detected quantity/order mismatch with broker state, remain blocked.

## Material limit and approval question

Atomic replacement reduces torn-file risk, but it cannot guarantee that the newest fill, floor arm, or latch reached disk before a process or machine crash. A missing or invalid file, or a detectable quantity/order mismatch, can be blocked. A stale file whose aggregate quantity and currently visible order still happen to match cannot be detected as stale: the broker exposes no proof that a newer per-contract floor or prior latch was lost. The broker's aggregate position and current orders cannot repair that missing information without introducing the historical/reconciliation machinery explicitly out of scope here. The safe consent semantics are therefore: approve this only as best-effort crash continuity, accepting a material relaxation of the invariant that exact current protection state always survives restart. If exact retention of every floor/latch is required, this snapshot alone is insufficient and the continuity design remains undecided. It is not an exact restart guarantee.

**Approval question:** does Joe accept this best-effort snapshot as a material relaxation of exact floor/latch retention across crashes, with detected missing/invalid/quantity/order mismatches blocked but undetectable stale protection state acknowledged? If exact retention is required, should this proposal remain unapproved and the continuity mechanism undecided? In either case, no aggregate broker average is used as a substitute.
