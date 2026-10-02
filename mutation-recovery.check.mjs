import assert from 'node:assert/strict';
import { createAlpacaBroker } from './alpaca.mjs';
import { createEntry } from './entry.mjs';
import { createPositions } from './positions.mjs';

const timeoutBroker = createAlpacaBroker({ key: 'test', secret: 'test', baseUrl: 'https://paper-api.alpaca.markets', mutationTimeoutMs: 20,
  fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
const keepAlive = setInterval(() => {}, 1000);
const order = { symbol: 'SPY260101C00500000', qty: 1, side: 'sell', limitPrice: 1, clientOrderId: 'test' };
for (const mutate of [() => timeoutBroker.submitOrder(order), () => timeoutBroker.replaceOrder('id', order), () => timeoutBroker.cancelOrder('id')]) {
  await assert.rejects(mutate, { name: 'TimeoutError' });
}
clearInterval(keepAlive);

const symbol = 'SPY260101C00500000';
let mono = 0;
let submits = 0;
let lookups = 0;
const sell = createPositions({ now: () => 10_000, nowMono: () => mono,
  broker: {
    submitOrder() { submits++; return Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })); },
    async getOrderByClientOrderId(id) { lookups++; assert.equal(id, sell.getTrades()[0].logicalSellId); return null; },
    async replaceOrder() { assert.fail('must not replace an unresolved submission'); },
  } });
sell.onFill({ tradeId: 'trade', executionId: 'buy-fill', symbol, entryPrice: 1, timestamp: 0 });
sell.onQuote({ symbol, bid: 0.89, ask: 0.90, timestamp: 10_000 });
sell.onQuote({ symbol, bid: 1.00, ask: 1.01, timestamp: 10_001 });
sell.onQuote({ symbol, bid: 0.95, ask: 0.96, timestamp: 10_002 });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(submits, 1);
assert.equal(lookups, 1);
assert.equal(sell.hasPendingExecution(), true);
assert.equal(sell.getTrades()[0].orderId, null);
mono = 5_000;
sell.reconcilePending();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(lookups, 2, 'unresolved client ID is re-read after the bounded cadence');
sell.onQuote({ symbol, bid: 0.88, ask: 0.89, timestamp: 10_001 });
assert.equal(submits, 1, 'missing lookup never permits another POST');

let resolveSubmit;
const streamRace = createPositions({ now: () => 10_000,
  broker: { submitOrder() { return new Promise((_resolve, reject) => { resolveSubmit = () => reject(new Error('late timeout')); }); } } });
streamRace.onFill({ tradeId: 'race', executionId: 'race-buy', symbol, entryPrice: 1, timestamp: 0 });
streamRace.onQuote({ symbol, bid: 0.89, ask: 0.90, timestamp: 10_000 });
streamRace.onQuote({ symbol, bid: 1.00, ask: 1.01, timestamp: 10_001 });
streamRace.onQuote({ symbol, bid: 0.95, ask: 0.96, timestamp: 10_002 });
const logicalSellId = streamRace.getTrades()[0].logicalSellId;
streamRace.onOrderUpdate({ orderId: 'stream-order', clientOrderId: logicalSellId, event: 'new' });
resolveSubmit();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(streamRace.getTrades()[0].orderId, 'stream-order');
assert.equal(streamRace.hasPendingExecution(), false, 'stream identity resolves the late submit timeout');

let lookupOrder = { id: 'parent', client_order_id: 'v5-buy-test', symbol, side: 'buy', qty: 3, filled_qty: '0', status: 'accepted' };
let entrySubmits = 0;
let entryReads = 0;
const entry = createEntry({ quantity: 3, nowMono: () => mono, getContracts: async () => [{ symbol, strike: 500 }], getQuote: async () => ({ bid: 1, ask: 1.01 }),
  broker: { async submitOrder({ clientOrderId }) { entrySubmits++; lookupOrder = { ...lookupOrder, client_order_id: clientOrderId }; throw new Error('timeout'); },
    async getOrderByClientOrderId() { entryReads++; return lookupOrder; } } });
await entry.onBreakout({ direction: 'CALL', spyPrice: 500, timestamp: 1 });
assert.equal(entry.getState().active, true);
assert.equal(entry.getState().orderId, 'parent');
assert.equal(entrySubmits, 1);
assert.equal(entryReads, 1);
assert.equal(entry.getState().filled, 0, 'REST aggregate fields do not synthesize executions');

let releaseRead;
const staleEntry = createEntry({ quantity: 3, nowMono: () => mono, getContracts: async () => [{ symbol, strike: 500 }], getQuote: async () => ({ bid: 1, ask: 1.01 }),
  broker: { async submitOrder() { throw new Error('timeout'); }, getOrderByClientOrderId() { return new Promise((resolve) => { releaseRead = resolve; }); } } });
await staleEntry.onBreakout({ direction: 'CALL', spyPrice: 500, timestamp: 1 });
const staleClientId = staleEntry.getState().clientOrderId;
staleEntry.onOrderUpdate({ clientOrderId: staleClientId, orderId: 'stream-canceled', event: 'canceled' });
releaseRead({ id: 'stream-canceled', client_order_id: staleClientId, symbol, side: 'buy', qty: 3, filled_qty: '0', status: 'accepted' });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(staleEntry.getState().state, 'DONE', 'late GET cannot regress terminal stream state');
assert.equal(staleEntry.getState().orderStatus, 'canceled');

let replacementReads = 0;
let replacementCalls = 0;
let replacementMono = 0;
const replacement = createPositions({ now: () => 10_000, nowMono: () => replacementMono,
  broker: { async submitOrder() { return { id: 'replace-parent', status: 'new' }; },
    async replaceOrder() { replacementCalls++; throw new Error('timeout'); },
    async getOrder(id) { replacementReads++; assert.equal(id, 'replace-parent'); return { id, symbol, side: 'sell', qty: '1', filled_qty: '0', status: 'accepted' }; } } });
replacement.onFill({ tradeId: 'replacement', executionId: 'replacement-buy', symbol, entryPrice: 1, timestamp: 0 });
replacement.onQuote({ symbol, bid: 0.89, ask: 0.90, timestamp: 10_000 });
replacement.onQuote({ symbol, bid: 1.00, ask: 1.01, timestamp: 10_001 });
replacement.onQuote({ symbol, bid: 0.95, ask: 0.96, timestamp: 10_002 });
await new Promise((resolve) => setImmediate(resolve));
replacement.onQuote({ symbol, bid: 0.94, ask: 0.95, timestamp: 10_003 });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(replacementCalls, 1);
assert.equal(replacementReads, 1);
assert.equal(replacement.hasPendingExecution(), true, 'unchanged parent is not proof replacement failed');
replacementMono = 5_000;
replacement.reconcilePending();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(replacementReads, 2);
assert.equal(replacementCalls, 1, 'reprice remains blocked until linked successor or explicit rejection');

let quoteAsk = 1.01;
let startReplace;
let finishReplace;
const replaceStarted = new Promise((resolve) => { startReplace = resolve; });
const replaceResponse = new Promise((resolve) => { finishReplace = resolve; });
const cancelIds = [];
let inFlightReplace;
inFlightReplace = createEntry({ quantity: 3, nowMono: () => mono, getContracts: async () => [{ symbol, strike: 500 }], getQuote: async () => ({ bid: 1, ask: quoteAsk }),
  onState: (state) => { if (state.status === 'FILLED' && !state.active) inFlightReplace.ready(); },
  broker: { async submitOrder() { return { id: 'filled-parent', status: 'new' }; },
    replaceOrder() { startReplace(); return replaceResponse; },
    async cancelOrder(id) { cancelIds.push(id); },
    async getOrder() { return { id: 'filled-child', symbol, side: 'buy', qty: 3, filled_qty: '0', status: 'accepted' }; } } });
await inFlightReplace.onBreakout({ direction: 'CALL', spyPrice: 500, timestamp: 1 });
const inFlightClientId = inFlightReplace.getState().clientOrderId;
quoteAsk = 1.02;
inFlightReplace.tick();
await replaceStarted;
inFlightReplace.onOrderUpdate({ clientOrderId: inFlightClientId, orderId: 'filled-parent', event: 'fill', executionId: 'parent-filled', fillQty: 3, fillPrice: 1, timestamp: 1 });
assert.equal(inFlightReplace.getState().active, true, 'in-flight replacement remains an admission block after parent fill');
inFlightReplace.ready();
assert.equal(inFlightReplace.getState().clientOrderId, inFlightClientId, 'ready cannot discard an in-flight mutation identity');
finishReplace({ id: 'filled-child', status: 'new' });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(inFlightReplace.getState().orderId, 'filled-child');
assert.deepEqual(cancelIds, ['filled-child'], 'a live child is canceled when the parent filled during PATCH');
assert.equal(inFlightReplace.getState().active, true, 'child cancellation remains unresolved until terminal evidence');

let parentReplaceReject;
let parentReplaceStart;
const parentReplaceStarted = new Promise((resolve) => { parentReplaceStart = resolve; });
const parentReplacePending = new Promise((_resolve, reject) => { parentReplaceReject = () => reject(new Error('late timeout')); });
const parentFillCancels = [];
let parentFillEntry;
parentFillEntry = createEntry({ quantity: 3, nowMono: () => mono, getContracts: async () => [{ symbol, strike: 500 }], getQuote: async () => ({ bid: 1, ask: quoteAsk }),
  onState: (state) => { if (state.status === 'FILLED' && !state.active) parentFillEntry.ready(); },
  broker: { async submitOrder() { return { id: 'parent-fill-order', status: 'new' }; },
    replaceOrder() { parentReplaceStart(); return parentReplacePending; },
    async cancelOrder(id) { parentFillCancels.push(id); },
    async getOrder(id) { return { id, symbol, side: 'buy', qty: 3, filled_qty: '3', status: 'accepted' }; } } });
await parentFillEntry.onBreakout({ direction: 'CALL', spyPrice: 500, timestamp: 1 });
quoteAsk = 1.03;
parentFillEntry.tick();
await parentReplaceStarted;
const parentFillClientId = parentFillEntry.getState().clientOrderId;
parentFillEntry.onOrderUpdate({ clientOrderId: parentFillClientId, orderId: 'parent-fill-order', replacedBy: 'stream-live-child', event: 'fill', executionId: 'parent-fill-with-child', fillQty: 3, fillPrice: 1, timestamp: 1 });
parentReplaceReject();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(parentFillEntry.getState().orderId, 'stream-live-child');
assert.deepEqual(parentFillCancels, ['stream-live-child'], 'parent fill with replaced_by must cancel the still-live child');
assert.equal(parentFillEntry.getState().active, true, 'child stays an admission block until terminal evidence');

let cancelMono = 0;
let deleteCount = 0;
let cancelReads = 0;
const cancelEntry = createEntry({ quantity: 3, nowMono: () => cancelMono, getContracts: async () => [{ symbol, strike: 500 }], getQuote: async () => ({ bid: 1, ask: 1.01 }),
  broker: { async submitOrder() { return { id: 'cancel-parent', status: 'new' }; },
    async cancelOrder() { deleteCount++; throw new Error('timeout'); },
    async getOrder(id) { cancelReads++; return { id, symbol, side: 'buy', qty: 3, filled_qty: '0', status: cancelReads === 1 ? 'accepted' : 'canceled' }; } } });
await cancelEntry.onBreakout({ direction: 'CALL', spyPrice: 500, timestamp: 1 });
cancelMono = 2_000;
cancelEntry.tick();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(deleteCount, 1);
assert.equal(cancelReads, 1);
assert.equal(cancelEntry.getState().active, true, 'open order after cancel timeout remains blocked');
cancelMono = 7_000;
cancelEntry.tick();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(deleteCount, 1, 'cancel timeout is never blindly resent');
assert.equal(cancelReads, 2);
assert.equal(cancelEntry.getState().state, 'DONE', 'terminal readback resolves cancellation uncertainty');

let streamReplaceReject;
let streamReplaceStarted;
const streamReplaceReady = new Promise((resolve) => { streamReplaceStarted = resolve; });
const streamReplaceResult = new Promise((_resolve, reject) => { streamReplaceReject = () => reject(new Error('late timeout')); });
quoteAsk = 1.01;
const streamedChild = createEntry({ quantity: 3, nowMono: () => 0, getContracts: async () => [{ symbol, strike: 500 }], getQuote: async () => ({ bid: 1, ask: quoteAsk }),
  broker: { async submitOrder() { return { id: 'stream-parent', status: 'new' }; },
    replaceOrder() { streamReplaceStarted(); return streamReplaceResult; },
    async getOrder() { assert.fail('exact child stream already resolved the replacement'); } } });
await streamedChild.onBreakout({ direction: 'CALL', spyPrice: 500, timestamp: 1 });
quoteAsk = 1.02;
streamedChild.tick();
await streamReplaceReady;
const streamReplaceClientId = streamedChild.getState().clientOrderId;
streamedChild.onOrderUpdate({ clientOrderId: streamReplaceClientId, orderId: 'stream-child', replaces: 'stream-parent', event: 'new' });
streamReplaceReject();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(streamedChild.getState().orderId, 'stream-child');
assert.equal(streamedChild.getState().status, 'new', 'late timeout cannot regress a linked successor stream event');

let parentLookupResolve;
let parentLookupCount = 0;
let parentStreamCancel = 0;
let parentStreamMono = 0;
quoteAsk = 1.01;
const replacedByTimeout = createEntry({ quantity: 3, nowMono: () => parentStreamMono, getContracts: async () => [{ symbol, strike: 500 }], getQuote: async () => ({ bid: 1, ask: quoteAsk }),
  broker: { async submitOrder() { return { id: 'timeout-parent', status: 'new' }; },
    async replaceOrder() { throw new Error('timeout'); },
    async getOrder(id) {
      if (id === 'timeout-parent') { parentLookupCount++; return new Promise((resolve) => { parentLookupResolve = resolve; }); }
      return { id, symbol, side: 'buy', qty: 3, filled_qty: '3', status: 'accepted' };
    },
    async cancelOrder(id) { assert.equal(id, 'timeout-child'); parentStreamCancel++; } } });
await replacedByTimeout.onBreakout({ direction: 'CALL', spyPrice: 500, timestamp: 1 });
quoteAsk = 1.02;
replacedByTimeout.tick();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(parentLookupCount, 1);
const timeoutClientId = replacedByTimeout.getState().clientOrderId;
replacedByTimeout.onOrderUpdate({ clientOrderId: timeoutClientId, orderId: 'timeout-parent', replacedBy: 'timeout-child', event: 'fill', executionId: 'timeout-parent-fill', fillQty: 3, fillPrice: 1, timestamp: 1 });
assert.equal(replacedByTimeout.getState().orderId, 'timeout-child');
assert.equal(parentStreamCancel, 1, 'parent replacement stream adopts and cancels its live child');
parentLookupResolve({ id: 'timeout-parent', client_order_id: timeoutClientId, symbol, side: 'buy', qty: 3, filled_qty: '3', status: 'filled' });
await new Promise((resolve) => setImmediate(resolve));
parentStreamMono = 5_000;
replacedByTimeout.tick();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(parentLookupCount, 1, 'stale parent lookup cannot leave replaced_by recovery pending');

let replaceGetCount = 0;
const replaceGetIds = [];
const replaceIssues = [];
let linkedReplaceCalls = 0;
const linkedReplace = createPositions({ now: () => 10_000, nowMono: () => 0,
  broker: { async submitOrder() { return { id: 'linked-parent', status: 'new' }; },
    async replaceOrder() { if (++linkedReplaceCalls === 1) throw new Error('timeout'); return { id: 'linked-final', status: 'new' }; },
    async getOrder(id) {
      replaceGetCount++;
      replaceGetIds.push(id);
      if (id === 'linked-parent') return { id, symbol, side: 'sell', qty: '1', filled_qty: '0', status: 'accepted', replaced_by: 'linked-child' };
      assert.equal(id, 'linked-child');
      return { id, symbol, side: 'sell', qty: '1', filled_qty: '0', status: 'accepted', replaces: 'linked-parent' };
    } }, onExecutionIssue(issue) { replaceIssues.push(issue); } });
linkedReplace.onFill({ tradeId: 'linked', executionId: 'linked-buy', symbol, entryPrice: 1, timestamp: 0 });
linkedReplace.onQuote({ symbol, bid: 0.89, ask: 0.90, timestamp: 10_000 });
linkedReplace.onQuote({ symbol, bid: 1.00, ask: 1.01, timestamp: 10_001 });
linkedReplace.onQuote({ symbol, bid: 0.95, ask: 0.96, timestamp: 10_002 });
await new Promise((resolve) => setImmediate(resolve));
linkedReplace.onQuote({ symbol, bid: 0.94, ask: 0.95, timestamp: 10_003 });
await new Promise((resolve) => setImmediate(resolve));
assert.ok(replaceGetCount >= 2, 'replacement lookup verifies parent then reciprocal child lineage');
assert.deepEqual(replaceGetIds.slice(0, 2), ['linked-parent', 'linked-child']);
assert.ok(['linked-child', 'linked-final'].includes(linkedReplace.getTrades()[0].orderId));
assert.equal(linkedReplace.hasPendingExecution(), false, `exact linked successor resolves replacement uncertainty ${JSON.stringify(replaceIssues)}`);

let buyChildResolve;
let buyChildLookupStarted;
const buyChildLookup = new Promise((resolve) => { buyChildLookupStarted = resolve; });
let buyChildCancelCount = 0;
let buyChildReads = 0;
let restBuyMono = 0;
quoteAsk = 1.01;
const restBuyChild = createEntry({ quantity: 3, nowMono: () => restBuyMono, getContracts: async () => [{ symbol, strike: 500 }], getQuote: async () => ({ bid: 1, ask: quoteAsk }),
  broker: { async submitOrder() { return { id: 'rest-buy-parent', status: 'new' }; },
    async replaceOrder() { throw new Error('timeout'); },
    async getOrder(id) {
      if (id === 'rest-buy-parent') return { id, symbol, side: 'buy', qty: 3, filled_qty: '3', status: 'filled', replaced_by: 'rest-buy-child' };
      buyChildReads++;
      if (buyChildReads === 1) { buyChildLookupStarted(); return new Promise((resolve) => { buyChildResolve = resolve; }); }
      return { id, symbol, side: 'buy', qty: 3, filled_qty: '0', status: 'accepted', replaces: 'rest-buy-parent' };
    },
    async cancelOrder(id) { assert.equal(id, 'rest-buy-child'); buyChildCancelCount++; } } });
await restBuyChild.onBreakout({ direction: 'CALL', spyPrice: 500, timestamp: 1 });
const restBuyClientId = restBuyChild.getState().clientOrderId;
quoteAsk = 1.02;
restBuyChild.tick();
await buyChildLookup;
restBuyChild.onOrderUpdate({ clientOrderId: restBuyClientId, orderId: 'rest-buy-parent', event: 'fill', executionId: 'rest-buy-fill', fillQty: 3, fillPrice: 1, timestamp: 1 });
buyChildResolve({ id: 'rest-buy-child', symbol, side: 'buy', qty: 3, filled_qty: '0', status: 'accepted', replaces: 'rest-buy-parent' });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(restBuyChild.getState().orderId, 'rest-buy-child');
assert.equal(buyChildCancelCount, 1, 'REST-discovered live child is canceled after parent fills');
assert.equal(restBuyChild.getState().active, true, 'aggregate mismatch keeps BUY ownership unresolved');
restBuyMono = 5_000;
restBuyChild.tick();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(buyChildCancelCount, 1, 'REST recovery never repeats child cancel');

let sellChildResolve;
let sellChildLookupStarted;
const sellChildLookup = new Promise((resolve) => { sellChildLookupStarted = resolve; });
let sellChildReads = 0;
let sellChildCancelCount = 0;
let restSellMono = 0;
const restSellChild = createPositions({ now: () => 10_000, nowMono: () => restSellMono,
  broker: { async submitOrder() { return { id: 'rest-sell-parent', status: 'new' }; },
    async replaceOrder() { throw new Error('timeout'); },
    async getOrder(id) {
      if (id === 'rest-sell-parent') return { id, symbol, side: 'sell', qty: '1', filled_qty: '1', status: 'filled', replaced_by: 'rest-sell-child' };
      sellChildReads++;
      if (sellChildReads === 1) { sellChildLookupStarted(); return new Promise((resolve) => { sellChildResolve = resolve; }); }
      return { id, symbol, side: 'sell', qty: '1', filled_qty: '0', status: 'accepted', replaces: 'rest-sell-parent' };
    },
    async cancelOrder(id) { assert.equal(id, 'rest-sell-child'); sellChildCancelCount++; } } });
restSellChild.onFill({ tradeId: 'rest-sell', executionId: 'rest-sell-buy', symbol, entryPrice: 1, timestamp: 0 });
restSellChild.onQuote({ symbol, bid: 0.89, ask: 0.90, timestamp: 10_000 });
restSellChild.onQuote({ symbol, bid: 1.00, ask: 1.01, timestamp: 10_001 });
restSellChild.onQuote({ symbol, bid: 0.95, ask: 0.96, timestamp: 10_002 });
await new Promise((resolve) => setImmediate(resolve));
restSellChild.onQuote({ symbol, bid: 0.94, ask: 0.95, timestamp: 10_003 });
await sellChildLookup;
restSellChild.onOrderUpdate({ orderId: 'rest-sell-parent', event: 'fill', executionId: 'rest-sell-exit', fillQty: 1, fillPrice: 0.95, timestamp: 10_004 });
sellChildResolve({ id: 'rest-sell-child', symbol, side: 'sell', qty: '1', filled_qty: '0', status: 'accepted', replaces: 'rest-sell-parent' });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(restSellChild.getTrades()[0].orderId, 'rest-sell-child');
assert.equal(sellChildCancelCount, 1, 'REST-discovered SELL child is canceled after ownership closes');
assert.equal(restSellChild.hasPendingExecution(), true, 'SELL aggregate mismatch remains blocked');
restSellMono = 5_000;
restSellChild.reconcilePending();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(sellChildCancelCount, 1, 'SELL child cancellation is not retried');
console.log('bounded mutation timeout and ambiguous recovery checks passed');
