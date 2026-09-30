import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireTradeAuthority, assertManualMarkerClear, readManualOwnershipMarker, recordManualOrder } from '../trade-authority.mjs';
import { createAlpacaBroker } from '../alpaca.mjs';
import { brokerSnapshot, request, tools } from './broker.mjs';
import { PAPER_ACCOUNT_ID } from './config.mjs';

const testDirectory = await mkdtemp(join(tmpdir(), 'v5-bridge-lane1-'));
const markerPath = join(testDirectory, 'manual.json');
const account = (id = PAPER_ACCOUNT_ID) => ({ id, status: 'ACTIVE', buying_power: '100000' });
const calls = [];
let heldQty = 0;
let nextOrder = 0;
const orderBook = new Map();
function response(body, status = 200) { return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-request-id': 'fixture' } }); }
const context = {
  resolvePaper: async () => ({ mode: 'paper', baseUrl: 'https://paper-api.alpaca.markets', dataUrl: 'https://data.alpaca.markets', apiKey: 'fixture-key', apiSecret: 'fixture-secret' }),
  withManualAuthority: async (operation) => operation(),
  manualMarkerPath: markerPath,
  fetchImpl: async (url, init) => {
    const parsed = new URL(url), path = parsed.pathname, method = init.method;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: parsed, method, body });
    if (path === '/v2/account') return response(account());
    if (path === '/v2/positions') return response(heldQty ? [{ symbol: 'SPY260921C00600000', qty: String(heldQty) }] : []);
    if (path === '/v2/account/activities/FILL') return response([]);
    if (path === '/v2/orders' && method === 'POST') {
      const id = `order-${++nextOrder}`;
      const row = { id, ...body, status: 'filled', filled_qty: String(body.qty), replaced_by: null };
      orderBook.set(id, row);
      heldQty += (body.side === 'buy' ? 1 : -1) * Number(body.qty);
      return response(row);
    }
    if (path === '/v2/orders' && method === 'GET') {
      const rows = [...orderBook.values()].filter((order) => ['new', 'accepted', 'pending_new', 'partially_filled', 'pending_replace', 'pending_cancel'].includes(order.status));
      return response(rows);
    }
    if (path === '/v2/orders:by_client_order_id') {
      const row = [...orderBook.values()].find((order) => order.client_order_id === parsed.searchParams.get('client_order_id'));
      return row ? response(row) : response({ message: 'not found' }, 404);
    }
    const match = /^\/v2\/orders\/([^/]+)$/.exec(path);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const row = orderBook.get(id);
      if (!row) return response({ message: 'not found' }, 404);
      if (method === 'DELETE') { row.status = 'canceled'; return response(null, 204); }
      if (method === 'PATCH') {
        const nextId = `order-${++nextOrder}`;
        const successor = { ...row, ...body, id: nextId, status: 'new', filled_qty: '0' };
        row.status = 'replaced'; row.replaced_by = nextId;
        orderBook.set(nextId, successor);
        return response(successor);
      }
      return response(row);
    }
    return response({ ok: true });
  },
};
const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
const buy = (id = 'bridge-manual-test-buy') => ({ symbol: 'SPY260921C00600000', qty: 1, side: 'buy', position_intent: 'buy_to_open', type: 'limit', time_in_force: 'day', limit_price: '1.00', client_order_id: id, provenance: 'BRIDGE_MANUAL' });
const sell = (id = 'bridge-manual-test-sell') => ({ symbol: 'SPY260921C00600000', qty: 1, side: 'sell', position_intent: 'sell_to_close', type: 'limit', time_in_force: 'day', limit_price: '1.05', client_order_id: id, provenance: 'BRIDGE_MANUAL' });

for (const tool of tools) {
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(Object.hasOwn(tool.inputSchema.properties, 'mode'), false, `${tool.name} has no public mode selector`);
}
await assert.rejects(byName.broker_account.handler({ mode: 'live' }, context), /PAPER|mode/u);
const accountRead = await byName.broker_account.handler({}, context);
assert.equal(accountRead.data.id, PAPER_ACCOUNT_ID);
assert.equal(accountRead.request.mode, 'paper');

for (const [name, args, host, pathname] of [
  ['broker_stock_trade', { symbol: 'SPY' }, 'data.alpaca.markets', '/v2/stocks/trades/latest'],
  ['broker_stock_historical_bars', { symbols: 'SPY', timeframe: '1Min', start: '2026-09-01', end: '2026-09-02' }, 'data.alpaca.markets', '/v2/stocks/bars'],
  ['broker_option_quotes', { symbols: 'SPY260921C00600000' }, 'data.alpaca.markets', '/v1beta1/options/quotes/latest'],
  ['broker_option_historical_quotes', { symbols: 'SPY260921C00600000', start: '2026-09-01', end: '2026-09-02' }, 'data.alpaca.markets', '/v1beta1/options/quotes'],
  ['broker_option_historical_bars', { symbols: 'SPY260921C00600000', timeframe: '1Min', start: '2026-09-01', end: '2026-09-02' }, 'data.alpaca.markets', '/v1beta1/options/bars'],
  ['broker_option_contracts', {}, 'paper-api.alpaca.markets', '/v2/options/contracts'],
  ['broker_account_activities', {}, 'paper-api.alpaca.markets', '/v2/account/activities'],
  ['broker_fills', {}, 'paper-api.alpaca.markets', '/v2/account/activities/FILL'],
  ['broker_portfolio_history', {}, 'paper-api.alpaca.markets', '/v2/account/portfolio/history'],
  ['broker_calendar', {}, 'paper-api.alpaca.markets', '/v2/calendar'],
]) {
  await byName[name].handler(args, context);
  assert.equal(calls.at(-1).url.host, host, `${name} host`);
  assert.equal(calls.at(-1).url.pathname, pathname, `${name} route`);
  assert.equal(calls.at(-2).url.pathname, '/v2/account', 'authenticated PAPER identity is checked first');
}

await assert.rejects(byName.broker_submit_order.handler(sell(), context), { code: 'MANUAL_SELL_OWNERSHIP_MISMATCH' });
const autoPositionContext = { ...context, fetchImpl: async (url) => { const parsed = new URL(url); return parsed.pathname === '/v2/account' ? response(account()) : parsed.pathname === '/v2/positions' ? response([{ symbol: 'SPY260921C00600000', qty: '1' }]) : parsed.pathname === '/v2/orders' ? response([]) : response({}); } };
await assert.rejects(byName.broker_submit_order.handler(sell(), autoPositionContext), { code: 'MANUAL_SELL_OWNERSHIP_MISMATCH' }, 'V5 or otherwise unmarked exposure cannot be manually sold');
await assert.rejects(byName.broker_submit_order.handler(buy(), autoPositionContext), { code: 'MANUAL_START_NOT_FLAT' }, 'manual BUY cannot overlap pre-existing exposure');
const opened = await byName.broker_submit_order.handler(buy(), context);
assert.equal(opened.owner, 'BRIDGE_MANUAL');
assert.equal(opened.after.data.status, 'filled');
assert.equal(opened.manualOwnership.status, 'active');
const markerBeforeLookup = await readManualOwnershipMarker({ markerPath });
await byName.broker_order.handler({ order_id: opened.after.data.id }, context);
await byName.broker_order_by_client_id.handler({ client_order_id: 'bridge-manual-test-buy' }, context);
assert.deepEqual(await readManualOwnershipMarker({ markerPath }), markerBeforeLookup, 'exact order reads do not write local ownership state');
const post = calls.findLast(({ method }) => method === 'POST');
assert.equal(post.body.client_order_id, 'bridge-manual-test-buy');
assert.equal(Object.hasOwn(post.body, 'provenance'), false);
const closed = await byName.broker_submit_order.handler(sell(), context);
assert.equal(closed.after.data.status, 'filled');
assert.equal(closed.manualOwnership.status, 'cleared');
assert.equal(heldQty, 0, 'mocked BUY fill then marker-owned SELL fill returns flat');

orderBook.set('manual-open', { id: 'manual-open', client_order_id: 'bridge-manual-cancel-me', symbol: 'SPY260921C00600000', side: 'buy', qty: '1', filled_qty: '0', status: 'new' });
const canceled = await byName.broker_cancel_order.handler({ order_id: 'manual-open', provenance: 'BRIDGE_MANUAL' }, context);
assert.equal(canceled.brokerResponse.ok, true);
assert.equal(canceled.after.data.status, 'canceled');
assert.equal(canceled.manualOwnership.status, 'cleared');

orderBook.set('manual-parent', { id: 'manual-parent', client_order_id: 'bridge-manual-parent', symbol: 'SPY260921C00600000', side: 'buy', qty: '1', filled_qty: '0', status: 'new', replaced_by: null });
const replaced = await byName.broker_replace_order.handler({ order_id: 'manual-parent', limit_price: '1.05', client_order_id: 'bridge-manual-successor', provenance: 'BRIDGE_MANUAL' }, context);
assert.equal(replaced.brokerResponse.ok, true);
assert.equal(replaced.after.data.status, 'new');
assert.equal(replaced.manualOwnership.status, 'active');
const successorId = replaced.after.data.id;
const replacementCanceled = await byName.broker_cancel_order.handler({ order_id: successorId, provenance: 'BRIDGE_MANUAL' }, context);
assert.equal(replacementCanceled.after.data.status, 'canceled');
assert.equal(replacementCanceled.manualOwnership.status, 'cleared');

heldQty = 1;
await recordManualOrder({ symbol: 'SPY260921C00600000', clientOrderId: 'bridge-manual-owned-buy', side: 'buy', qty: 1, filledQty: 1, orderId: 'owned-buy', status: 'filled', terminal: true }, { markerPath });
orderBook.set('manual-sell-open', { id: 'manual-sell-open', client_order_id: 'bridge-manual-sell-open', symbol: 'SPY260921C00600000', side: 'sell', qty: '1', filled_qty: '0', status: 'new' });
await assert.rejects(byName.broker_replace_order.handler({ order_id: 'manual-sell-open', qty: 2, limit_price: '1.05', client_order_id: 'bridge-manual-sell-successor-too-large', provenance: 'BRIDGE_MANUAL' }, context), { code: 'MANUAL_SELL_OWNERSHIP_MISMATCH' }, 'SELL replacement cannot exceed the confirmed marker-owned position');

let wrongAccountCalls = 0;
const wrongAccountContext = { ...context, fetchImpl: async () => { wrongAccountCalls += 1; return response(account('wrong-account')); } };
const rejected = await request('/v2/orders', { resolvePaper: context.resolvePaper, fetchImpl: wrongAccountContext.fetchImpl });
assert.equal(rejected.error.code, 'ACCOUNT_ID_MISMATCH');
assert.equal(wrongAccountCalls, 1, 'mismatched identity stops before broker route');
let routeCalls = 0;
const injectedLiveRoute = await request('/v2/account', { resolvePaper: async () => ({ mode: 'paper', baseUrl: 'https://api.alpaca.markets', dataUrl: 'https://data.alpaca.markets', apiKey: 'fixture-key', apiSecret: 'fixture-secret' }), fetchImpl: async () => { routeCalls += 1; return response({}); } });
assert.equal(injectedLiveRoute.error.code, 'PAPER_ROUTE_REJECTED');
assert.equal(routeCalls, 0, 'LIVE endpoint injection is rejected before network access');
const badDirectAccount = await byName.broker_account.handler({}, wrongAccountContext);
assert.equal(badDirectAccount.error.code, 'ACCOUNT_ID_MISMATCH');

const timeoutMarkerPath = join(testDirectory, 'timeout.json');
const timeoutContext = { ...context, manualMarkerPath: timeoutMarkerPath, fetchImpl: async (url, init) => {
  const parsed = new URL(url);
  if (parsed.pathname === '/v2/account') return response(account());
  if (parsed.pathname === '/v2/positions') return response([]);
  if (parsed.pathname === '/v2/orders' && init.method === 'POST') throw new Error('simulated timeout');
  if (parsed.pathname === '/v2/orders') return response([]);
  if (parsed.pathname === '/v2/orders:by_client_order_id') return response({ message: 'not found' }, 404);
  return response({});
} };
const ambiguous = await byName.broker_submit_order.handler(buy('bridge-manual-timeout'), timeoutContext);
assert.equal(ambiguous.brokerResponse.error.code, 'NETWORK_ERROR');
await assert.rejects(assertManualMarkerClear({ account: account(), positions: [], orders: [] }, { markerPath: timeoutMarkerPath }), { code: 'MANUAL_OWNERSHIP_UNRESOLVED' }, 'flat snapshot alone does not clear an ambiguous POST marker');

const startupMarkerPath = join(testDirectory, 'startup-marker.json');
await recordManualOrder({ symbol: 'SPY260921C00600000', clientOrderId: 'bridge-manual-startup-cancel', side: 'buy', qty: 1, orderId: 'startup-order', status: 'pending_cancel', terminal: false }, { markerPath: startupMarkerPath });
await assertManualMarkerClear({ account: account(), positions: [], orders: [] }, { markerPath: startupMarkerPath, readOrder: async (entry) => ({ id: entry.orderId, client_order_id: entry.clientOrderId, status: 'canceled' }) });
assert.equal(await readManualOwnershipMarker({ markerPath: startupMarkerPath }), null, 'terminal broker readback lets startup clear a resolved, flat manual marker');

const successorMarkerPath = join(testDirectory, 'startup-successor.json');
await recordManualOrder({ symbol: 'SPY260921C00600000', clientOrderId: 'bridge-manual-replace-parent', side: 'buy', qty: 1, orderId: 'parent-order', status: 'pending_replace', terminal: false }, { markerPath: successorMarkerPath });
await recordManualOrder({ symbol: 'SPY260921C00600000', clientOrderId: 'bridge-manual-replace-child', side: 'buy', qty: 1, orderId: 'child-order', status: 'pending', terminal: false }, { markerPath: successorMarkerPath });
const reconciledChain = [];
await assertManualMarkerClear({ account: account(), positions: [], orders: [] }, { markerPath: successorMarkerPath, readOrder: async (entry) => { reconciledChain.push(entry.orderId); return entry.orderId === 'parent-order' ? { id: 'parent-order', client_order_id: entry.clientOrderId, status: 'replaced', replaced_by: 'child-order' } : { id: 'child-order', client_order_id: 'bridge-manual-replace-child', status: 'canceled' }; } });
assert.deepEqual(reconciledChain, ['parent-order', 'child-order'], 'startup resolves the parent and the recorded exact successor before clearing');
assert.equal(await readManualOwnershipMarker({ markerPath: successorMarkerPath }), null);

const missingMarkerPath = join(testDirectory, 'startup-404.json');
await recordManualOrder({ symbol: 'SPY260921C00600000', clientOrderId: 'bridge-manual-startup-404', side: 'buy', qty: 1, orderId: 'missing-order', status: 'pending_cancel', terminal: false }, { markerPath: missingMarkerPath });
await assert.rejects(assertManualMarkerClear({ account: account(), positions: [], orders: [] }, { markerPath: missingMarkerPath, readOrder: async () => { throw Object.assign(new Error('not found'), { httpStatus: 404 }); } }), { code: 'MANUAL_OWNERSHIP_UNRESOLVED' }, '404 exact lookup does not establish terminality');

let exactOrderUrl;
const exactOrderBroker = createAlpacaBroker({ key: 'fixture', secret: 'fixture', baseUrl: 'https://paper-api.alpaca.markets', fetchImpl: async (url) => { exactOrderUrl = new URL(url); return { ok: true, text: async () => JSON.stringify({ id: 'startup-order', client_order_id: 'bridge-manual-startup-cancel', status: 'canceled' }) }; } });
await exactOrderBroker.getOrderByClientOrderId('bridge-manual-startup-cancel');
assert.equal(exactOrderUrl.pathname, '/v2/orders:by_client_order_id');
assert.equal(exactOrderUrl.searchParams.get('client_order_id'), 'bridge-manual-startup-cancel');
await assert.rejects(byName.broker_submit_order.handler({ ...buy('bridge-manual-zero'), qty: 0 }, context));

const snapshot = await brokerSnapshot(context);
assert.equal(snapshot.mode, 'paper');
assert.equal(snapshot.account.data.id, PAPER_ACCOUNT_ID);
assert.equal(snapshot.positions.ok, true);
const release = await acquireTradeAuthority('v5-paper', { lockPath: join(testDirectory, 'authority.lock') });
await assert.rejects(acquireTradeAuthority('bridge-manual', { lockPath: join(testDirectory, 'authority.lock') }), { code: 'PAPER_TRADE_AUTHORITY_LOCKED' });
assert.equal(await release(), true);
await rm(testDirectory, { recursive: true, force: true });
process.stdout.write('broker check passed: PAPER binding, mode-free schemas, SIP/OPRA reads, locked manual BUY/SELL, replace/cancel chain, ambiguous marker retention; mocks only\n');
