# V5 shared interfaces and dispatch boundaries
Authority: Notebook project 6d36bb46-bc94-426e-aab0-fe71535ac969, governance ca531975-3bac-4da2-8763-778f9407ad94.
User approved staggered dispatch on 2026-09-21. No approval yet for SIP eligibility or restart continuity choices.
Plain Node.js ESM .mjs modules; native platform first. No generalized event framework.
WS1 owns signal.mjs and signal.check.mjs.
WS2 owns entry.mjs and entry.check.mjs.
WS3 owns positions.mjs and positions.check.mjs.
WS4 owns runtime.mjs, alpaca.mjs, runtime.check.mjs, package.json, README.md.
Each worker owns only its own report docs/wsN-report.md.
No worker executes local commands, tests, runtime, CPJ, git, or broker actions. Parent owns process execution. Workers edit through apply_patch; provide exact focused check commands for parent.
No historical repository reuse. No extra workstreams or speculative investigations. Stop unclear items and report to Astra for user decision; continue only independent approved portions.

Minimal data:
BreakoutEvent {direction:'CALL'|'PUT', timestamp:string, spyPrice:number}.
FillEvent {executionId:string, tradeId:string, symbol:string, entryPrice:number, timestamp:string}; one per confirmed contract.
OptionQuote {symbol:string,bid:number,ask:number,timestamp:string}; caller supplies accepted updates in order, no collapse.
EntryState {orderId:string|null,status:string,remainingQty:number,active:boolean}.
Trade state {tradeId,symbol,entryPrice,remainingQty,profitFloor:null|number,sellLatched:boolean,logicalSellId:string|null,orderId:string|null}.
ExitEvent {executionId,tradeId,symbol,qty,price,timestamp}; confirmed fills only.
Broker methods used by components: submitOrder({symbol,qty,side,limitPrice,clientOrderId}) -> Promise<{id,status}>; replaceOrder(orderId,{qty,limitPrice}) -> Promise<{id,status}>; cancelOrder(orderId) -> Promise<void>.
Broker update normalized by runtime {executionId,orderId,event,fillQty,fillPrice,timestamp,replacedBy?}. fillQty is this execution's quantity, not cumulative filled quantity.
Inject nowMono() milliseconds for elapsed clocks. Date/source timestamps for session/window time. No synthetic broker fills.
WS1 createSignal({onBreakout}) exposes reset(nowMs), onTrade({timestamp,price},nowMs), setSession({date,open,close}); onTrade accepts already-eligible trades ONLY pending user-approved eligibility. Do not wire unfiltered SIP trades as eligible.
WS2 createEntry({broker,getContracts,getQuote,onFill,onState,nowMono}) exposes onBreakout(event), onOrderUpdate(update), tick(), getState(). getContracts(direction,timestamp) returns same-day SPY options [{symbol,strike}]; getQuote(symbol) returns OPRA OptionQuote. Runtime drives tick every 500ms plus exact deadline timer according to nextDeadline() returned by entry. No strategy choice for exact ATM tie: pause that case and report if unresolved.
WS3 createPositions({broker,onExit,onState,nowMono}) exposes onFill(fill), onQuote(quote), onOrderUpdate(update), getTrades(). Runtime forwards accepted quotes in order. WS3 may add restoreTrade(existing exact trade state) only to preserve supplied approved state, never invent restart basis/floor. Broker state zero can clear exposed state using explicit runtime instruction.
Expose additional tiny method only if required by approved rule; report its exact signature before integration.

