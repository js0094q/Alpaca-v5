import { z } from 'zod';
import { PAPER_ACCOUNT_ID, redact, resolvePaper } from './config.mjs';
import { readManualOwnershipMarker, recordManualOrder, reconcileManualOwnership } from '../trade-authority.mjs';


const str = z.string().min(1).max(512);
const num = z.number().finite().positive();
const optional = (schema) => schema.optional();
const queryKeys = new Set(['status', 'limit', 'after', 'until', 'direction', 'nested', 'symbols', 'side', 'page_token', 'order_id', 'date', 'page_size', 'start', 'end', 'expiration_date', 'expiration_date_gte', 'expiration_date_lte', 'underlying_symbols', 'root_symbol', 'type', 'style', 'strike_price_gte', 'strike_price_lte', 'feed', 'asset_class', 'before_order_id', 'after_order_id', 'show_deliverables', 'ppind', 'timeframe', 'adjustment', 'asof', 'sort', 'currency']);

const safePath = (path) => {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\r\n]/u.test(path)) throw Object.assign(new Error('Invalid API path.'), { code: 'INVALID_INPUT' });
  return path;
};

function dataEndpoint(path) {
  return path.startsWith('/v1beta1/options/') || path.startsWith('/v2/stocks/');
}

export async function request(path, options = {}) {
  path = safePath(path);
  const method = options.method ?? 'GET';
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) throw Object.assign(new Error('Unsupported broker method.'), { code: 'INVALID_INPUT' });
  if (method !== 'GET' && method !== 'DELETE' && !options.body) throw Object.assign(new Error('Broker mutation body is required.'), { code: 'INVALID_INPUT' });
  const endpoint = dataEndpoint(path) ? 'market_data' : 'trading';
  const requestMeta = { mode: 'paper', endpoint, method, path, requestedAt: new Date().toISOString() };
  let credentials;
  try { credentials = await (options.resolvePaper ?? resolvePaper)(options.credentialSource); }
  catch (error) {
    return { ok: false, status: null, request: { ...requestMeta, respondedAt: new Date().toISOString() }, data: null, error: { code: error?.code ?? 'CREDENTIAL_UNAVAILABLE', message: 'Credentials for the requested mode are unavailable.' } };
  }
  if (credentials.mode !== 'paper' || credentials.baseUrl !== 'https://paper-api.alpaca.markets' || credentials.dataUrl !== 'https://data.alpaca.markets') return { ok: false, status: null, request: { ...requestMeta, respondedAt: new Date().toISOString() }, data: null, error: { code: 'PAPER_ROUTE_REJECTED', message: 'Only the bound PAPER broker and Alpaca market-data endpoints are allowed.' } };
  const root = dataEndpoint(path) ? credentials.dataUrl : credentials.baseUrl;
  const url = new URL(path, root);
  if (url.origin !== root) throw Object.assign(new Error('Invalid API path.'), { code: 'INVALID_INPUT' });
  requestMeta.path = `${url.pathname}${url.search}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!(method === 'GET' && url.pathname === '/v2/account')) {
    let identity;
    try {
      const check = await fetchImpl(new URL('/v2/account', credentials.baseUrl), { method: 'GET', redirect: 'error', headers: { 'APCA-API-KEY-ID': credentials.apiKey, 'APCA-API-SECRET-KEY': credentials.apiSecret, Accept: 'application/json' }, signal: options.signal ?? AbortSignal.timeout(15000) });
      identity = check.ok ? await check.json() : null;
    } catch { identity = null; }
    if (identity?.id !== PAPER_ACCOUNT_ID) return { ok: false, status: null, request: { ...requestMeta, respondedAt: new Date().toISOString() }, data: null, error: { code: 'ACCOUNT_ID_MISMATCH', message: 'Authenticated account does not match the bound V5 PAPER account.' } };
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: 'error',
      headers: {
        'APCA-API-KEY-ID': credentials.apiKey,
        'APCA-API-SECRET-KEY': credentials.apiSecret,
        Accept: 'application/json',
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body), headers: { 'APCA-API-KEY-ID': credentials.apiKey, 'APCA-API-SECRET-KEY': credentials.apiSecret, Accept: 'application/json', 'Content-Type': 'application/json' } }),
      signal: options.signal ?? AbortSignal.timeout(15000),
    });
  } catch (error) {
    return { ok: false, status: null, request: { ...requestMeta, respondedAt: new Date().toISOString() }, data: null, error: { code: 'NETWORK_ERROR', message: error?.name === 'TimeoutError' ? 'Request timed out.' : 'Request failed.' } };
  }

  const responseMeta = {
    ...requestMeta,
    requestId: response.headers.get('x-request-id') ?? response.headers.get('x-alpaca-request-id') ?? null,
    respondedAt: new Date().toISOString(),
    ...(response.headers.get('date') ? { serverDate: response.headers.get('date') } : {}),
  };
  let text;
  try {
    text = await response.text();
  } catch {
    return { ok: false, status: response.status, request: responseMeta, data: null, error: { code: 'RESPONSE_READ_ERROR', message: 'Response body could not be read.' } };
  }
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { text }; }
  const data = redact(body);
  if (response.ok && url.pathname === '/v2/account' && data?.id !== PAPER_ACCOUNT_ID) return { ok: false, status: response.status, request: responseMeta, data: null, error: { code: 'ACCOUNT_ID_MISMATCH', message: 'Authenticated account does not match the bound V5 PAPER account.' } };
  const error = response.ok ? undefined : redact({
    code: body && typeof body === 'object' ? (body.code ?? body.error ?? `HTTP_${response.status}`) : `HTTP_${response.status}`,
    message: body && typeof body === 'object' ? (body.message ?? body.detail ?? response.statusText) : response.statusText,
    ...(body && typeof body === 'object' ? { details: body } : {}),
  });
  const partialResults = response.status === 207 && Array.isArray(data)
    ? data.map((item) => {
      const status = Number(item?.status);
      return { ok: Number.isInteger(status) ? status >= 200 && status < 300 : null, status: item?.status ?? null, code: item?.code ?? null, message: item?.message ?? null, item };
    })
    : undefined;
  return { ok: response.ok, status: response.status, request: responseMeta, data, ...(error ? { error } : {}), ...(partialResults ? { partialResults } : {}) };
}

const requestFor = (context, path, options = {}) => request(path, { ...options, ...(typeof context?.resolvePaper === 'function' ? { resolvePaper: context.resolvePaper } : {}), ...(typeof context?.fetchImpl === 'function' ? { fetchImpl: context.fetchImpl } : {}) });
export const paperRequest = requestFor;

function params(values, allow = queryKeys) {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(values ?? {})) {
    if (value === undefined || value === null) continue;
    if (!allow.has(key)) throw Object.assign(new Error(`Unsupported filter: ${key}`), { code: 'INVALID_INPUT' });
    if (typeof value === 'number' && !Number.isFinite(value)) throw Object.assign(new Error(`Invalid ${key}.`), { code: 'INVALID_INPUT' });
    q.set(key, String(value));
  }
  const result = q.toString();
  return result ? `?${result}` : '';
}

export async function brokerSnapshot(context = {}) {
  const [account, orders, fills, positions] = await Promise.all([
    requestFor(context, '/v2/account'),
    requestFor(context, '/v2/orders?status=all&limit=500&direction=desc&nested=true'),
    requestFor(context, '/v2/account/activities/FILL?page_size=100&direction=desc'),
    requestFor(context, '/v2/positions'),
  ]);
  const openOrders = await requestFor(context, '/v2/orders?status=open&limit=500&direction=desc&nested=true');
  const manualOwnership = await reconcileManualOwnership({ account, positions, openOrders }, context?.manualMarkerPath ? { markerPath: context.manualMarkerPath } : {});
  return { mode: 'paper', capturedAt: new Date().toISOString(), account, orders, openOrders, fills, positions, manualOwnership, orderHistoryMayBeTruncated: Array.isArray(orders.data) && orders.data.length === 500, openOrdersMayBeTruncated: Array.isArray(openOrders.data) && openOrders.data.length === 500, fillsMayBeTruncated: Array.isArray(fills.data) && fills.data.length === 100 };
}

const base = {};
const orderFilterSchema = {
  status: optional(z.enum(['open', 'closed', 'all'])), limit: optional(z.number().int().min(1).max(500)),
  after: optional(str), until: optional(str), direction: optional(z.enum(['asc', 'desc'])),
  nested: optional(z.boolean()), symbols: optional(str), side: optional(z.enum(['buy', 'sell'])),
  asset_class: optional(str), before_order_id: optional(str), after_order_id: optional(str),
};
const fillFilterSchema = { after: optional(str), until: optional(str), direction: optional(z.enum(['asc', 'desc'])), page_token: optional(str), order_id: optional(str), date: optional(str), page_size: optional(z.number().int().min(1).max(100)) };
const orderId = str;
const stockFeed = z.literal('sip');
const optionFeed = z.literal('opra');
const historyFilters = { start: str, end: str, limit: optional(z.number().int().min(1).max(10000)), page_token: optional(str), sort: optional(z.enum(['asc', 'desc'])) };
const optionHistoryFilters = { ...historyFilters, symbols: str };
const optionQuoteHistoryFilters = { ...historyFilters, symbols: str };
const stockHistoryFilters = { ...historyFilters, feed: optional(stockFeed), symbols: str };

function tool(name, description, fields, handler) {
  const schema = z.strictObject(fields);
  const json = z.toJSONSchema(schema);
  return { name, description, inputSchema: json, handler: async (args, context = {}) => { if (args?.mode !== undefined) throw Object.assign(new Error('This bridge is bound to PAPER; mode is not selectable.'), { code: 'INVALID_INPUT' }); return handler(schema.parse(args), context); } };
}

const orderIdPath = (id) => `/v2/orders/${encodeURIComponent(id)}`;
const positionPath = (symbol) => `/v2/positions/${encodeURIComponent(symbol)}`;
async function withManualAuthority(context, fn) { if (typeof context?.withManualAuthority !== 'function') throw Object.assign(new Error('Manual order controls are unavailable until exclusive PAPER authority is available.'), { code: 'BOT_STATUS_UNKNOWN' }); return context.withManualAuthority(fn); }
async function requireManualOrder(context, order_id) { const found = await requestFor(context, orderIdPath(order_id)); if (!found.ok || found.data?.id !== order_id || !String(found.data?.client_order_id ?? '').startsWith('bridge-manual-')) throw Object.assign(new Error('Order is missing or is not owned by BRIDGE_MANUAL.'), { code: 'ORDER_OWNERSHIP_MISMATCH' }); return found; }
const markerOptions = (context) => context?.manualMarkerPath ? { markerPath: context.manualMarkerPath } : {};
const rememberManualOrder = (context, order) => recordManualOrder(order, markerOptions(context));
async function readManualBrokerState(context) { const [account, positions, openOrders] = await Promise.all([requestFor(context, '/v2/account'), requestFor(context, '/v2/positions'), requestFor(context, '/v2/orders?status=open&limit=500&direction=desc&nested=true')]); return { account, positions, openOrders }; }
async function resolveManualOrder(context, entry) { const path = entry.orderId ? orderIdPath(entry.orderId) : `/v2/orders:by_client_order_id${params({ client_order_id: entry.clientOrderId }, new Set(['client_order_id']))}`; return requestFor(context, path); }
async function currentManualOwnership(context) { const snapshot = await readManualBrokerState(context); return reconcileManualOwnership(snapshot, { ...markerOptions(context), readOrder: (entry) => resolveManualOrder(context, entry) }); }
const terminalStatus = (status) => ['filled', 'canceled', 'cancelled', 'rejected', 'expired', 'replaced'].includes(String(status ?? '').toLowerCase());
async function assertManualSellReplacementQty(context, existing, targetQty) {
  if (existing.data.side !== 'sell' || targetQty === undefined) return;
  const [account, positions] = await Promise.all([requestFor(context, '/v2/account'), requestFor(context, '/v2/positions')]);
  if (!account.ok || account.data?.id !== PAPER_ACCOUNT_ID || !positions.ok || !Array.isArray(positions.data)) throw Object.assign(new Error('PAPER position ownership is incomplete; replacement rejected.'), { code: 'BROKER_STATE_UNKNOWN' });
  const marker = await readManualOwnershipMarker(markerOptions(context));
  const ownedBuy = marker?.orders.some((entry) => entry.side === 'buy' && entry.symbol === existing.data.symbol && Number(entry.filledQty) > 0);
  const position = positions.data.find((entry) => entry.symbol === existing.data.symbol);
  const remaining = Number(position?.qty ?? position?.quantity);
  const filled = Number(existing.data.filled_qty ?? 0);
  const requested = Number(targetQty);
  if (!ownedBuy || !Number.isFinite(remaining) || !Number.isFinite(filled) || !Number.isFinite(requested) || requested < filled || requested > remaining + filled) throw Object.assign(new Error('A BRIDGE_MANUAL SELL replacement cannot exceed the confirmed marker-owned position.'), { code: 'MANUAL_SELL_OWNERSHIP_MISMATCH' });
}
async function manualEntryPreflight(context, { symbol, side, qty }) {
  const snapshot = await readManualBrokerState(context);
  const ownership = await reconcileManualOwnership(snapshot, { ...markerOptions(context), readOrder: (entry) => resolveManualOrder(context, entry) });
  for (const response of Object.values(snapshot)) if (!response.ok) throw Object.assign(new Error('PAPER account state is incomplete; manual order rejected.'), { code: 'BROKER_STATE_UNKNOWN' });
  if (!Array.isArray(snapshot.positions.data) || !Array.isArray(snapshot.openOrders.data) || snapshot.openOrders.data.length >= 500) throw Object.assign(new Error('PAPER positions or open orders are incomplete; manual order rejected.'), { code: 'BROKER_STATE_UNKNOWN' });
  if (ownership.status === 'unknown') throw Object.assign(new Error('BRIDGE_MANUAL order ownership is unresolved.'), { code: 'MANUAL_OWNERSHIP_UNRESOLVED' });
  const positions = snapshot.positions.data, orders = snapshot.openOrders.data;
  if (side === 'buy') {
    if (ownership.status !== 'none' && ownership.status !== 'cleared' || positions.length || orders.length) throw Object.assign(new Error('A manual BUY requires a flat PAPER account with no open orders.'), { code: 'MANUAL_START_NOT_FLAT' });
    return;
  }
  const marker = await readManualOwnershipMarker(markerOptions(context));
  const ownedBuy = marker?.orders.some((order) => order.side === 'buy' && order.symbol === symbol && (Number(order.filledQty) > 0 || String(order.status).toLowerCase() === 'filled'));
  const position = positions.find((item) => item.symbol === symbol);
  const qtyNumber = Number(qty), positionQty = Number(position?.qty ?? position?.quantity);
  if (!ownedBuy || ownership.status !== 'active' || !position || positions.length !== 1 || orders.length || !Number.isFinite(positionQty) || positionQty < qtyNumber) throw Object.assign(new Error('A manual SELL requires a BRIDGE_MANUAL-owned position, enough confirmed quantity, and no open orders.'), { code: 'MANUAL_SELL_OWNERSHIP_MISMATCH' });
}
const manualOrderId = z.string().regex(/^bridge-manual-[A-Za-z0-9-]{1,34}$/u);
const positiveDecimal = z.union([z.number().finite().positive(), z.string().regex(/^\d+(?:\.\d+)?$/u).refine((value) => Number.isFinite(Number(value)) && Number(value) > 0)]);
const orderBody = z.strictObject({ symbol: z.string().regex(/^SPY\d{6}[CP]\d{8}$/u), qty: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/u)]), side: z.enum(['buy', 'sell']), position_intent: z.enum(['buy_to_open', 'sell_to_close']), type: z.literal('limit'), time_in_force: z.literal('day'), limit_price: positiveDecimal, client_order_id: manualOrderId, provenance: z.literal('BRIDGE_MANUAL') }).refine((v) => (v.side === 'buy') === (v.position_intent === 'buy_to_open'), 'Option side and position_intent must agree.');
const replaceBody = z.strictObject({ order_id: orderId, qty: optional(z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/u)])), limit_price: optional(positiveDecimal), client_order_id: manualOrderId, provenance: z.literal('BRIDGE_MANUAL') }).refine((v) => v.qty !== undefined || v.limit_price !== undefined, 'A replacement qty or limit_price is required.');

export const tools = [
  tool('broker_account_activities', 'Read account activities by date and optional activity type.', { activity_type: optional(str), after: optional(str), until: optional(str), direction: optional(z.enum(['asc', 'desc'])), page_size: optional(z.number().int().min(1).max(100)), page_token: optional(str) }, ({ activity_type, ...filters }, context) => requestFor(context, `/v2/account/activities${activity_type ? `/${encodeURIComponent(activity_type)}` : ''}${params(filters)}`)),
  tool('broker_portfolio_history', 'Read account equity and profit/loss history.', { period: optional(str), timeframe: optional(str), date_end: optional(str), date_start: optional(str), intraday_reporting: optional(str), sort: optional(str), pnl_reset: optional(str) }, (filters, context) => requestFor(context, `/v2/account/portfolio/history${params(filters, new Set(['period', 'timeframe', 'date_end', 'date_start', 'intraday_reporting', 'sort', 'pnl_reset']))}`)),
  tool('broker_submit_order', 'Submit one long SPY option BRIDGE_MANUAL PAPER limit/day order. client_order_id must start bridge-manual-.', { ...orderBody.shape }, async (body, context) => withManualAuthority(context, async () => { const { provenance, ...order } = orderBody.parse(body); await manualEntryPreflight(context, { symbol: order.symbol, side: order.side, qty: order.qty }); await rememberManualOrder(context, { symbol: order.symbol, clientOrderId: order.client_order_id, side: order.side, qty: order.qty, status: 'pending', terminal: false }); const response = await requestFor(context, '/v2/orders', { method: 'POST', body: order }); const after = response.data?.id ? await requestFor(context, orderIdPath(response.data.id)) : await resolveManualOrder(context, { clientOrderId: order.client_order_id }); const status = after.ok ? after.data?.status : null; await rememberManualOrder(context, { symbol: order.symbol, clientOrderId: order.client_order_id, side: order.side, qty: order.qty, filledQty: after.data?.filled_qty ?? response.data?.filled_qty, orderId: after.data?.id ?? response.data?.id ?? null, status: status ?? 'unknown', terminal: terminalStatus(status) }); return { provenance, owner: 'BRIDGE_MANUAL', client_order_id: order.client_order_id, brokerResponse: response, after, manualOwnership: await currentManualOwnership(context) }; })),
  tool('broker_cancel_order', 'Cancel one identified BRIDGE_MANUAL PAPER order. V5 must be stopped.', { order_id: orderId, provenance: z.literal('BRIDGE_MANUAL') }, async ({ order_id, provenance }, context) => withManualAuthority(context, async () => { const existing = await requireManualOrder(context, order_id); await rememberManualOrder(context, { symbol: existing.data.symbol, clientOrderId: existing.data.client_order_id, side: existing.data.side, qty: existing.data.qty, orderId: order_id, status: 'pending_cancel', terminal: false }); const brokerResponse = await requestFor(context, orderIdPath(order_id), { method: 'DELETE' }); const after = brokerResponse.ok ? await requestFor(context, orderIdPath(order_id)) : null; await rememberManualOrder(context, { symbol: existing.data.symbol, clientOrderId: existing.data.client_order_id, side: existing.data.side, qty: existing.data.qty, orderId: order_id, status: after?.data?.status ?? 'unknown', terminal: terminalStatus(after?.data?.status) }); return { provenance, owner: provenance, brokerResponse, after, manualOwnership: await currentManualOwnership(context) }; })),
  tool('broker_replace_order', 'Replace quantity or limit price on one BRIDGE_MANUAL PAPER order. V5 must be stopped.', { ...replaceBody.shape }, async ({ order_id, provenance, ...replacement }, context) => withManualAuthority(context, async () => { const existing = await requireManualOrder(context, order_id); const successorId = replacement.client_order_id; const successorQty = replacement.qty ?? existing.data.qty; await assertManualSellReplacementQty(context, existing, replacement.qty); await rememberManualOrder(context, { symbol: existing.data.symbol, clientOrderId: existing.data.client_order_id, side: existing.data.side, qty: existing.data.qty, filledQty: existing.data.filled_qty, orderId: order_id, status: 'pending_replace', terminal: false }); await rememberManualOrder(context, { symbol: existing.data.symbol, clientOrderId: successorId, side: existing.data.side, qty: successorQty, status: 'pending', terminal: false }); const brokerResponse = await requestFor(context, orderIdPath(order_id), { method: 'PATCH', body: replacement }); const parent = await requestFor(context, orderIdPath(order_id)); const linkedId = parent.data?.replaced_by ?? brokerResponse.data?.id; const after = linkedId ? await requestFor(context, orderIdPath(linkedId)) : await resolveManualOrder(context, { clientOrderId: successorId }); const parentStatus = parent.ok ? parent.data?.status : null; await rememberManualOrder(context, { symbol: existing.data.symbol, clientOrderId: existing.data.client_order_id, side: existing.data.side, qty: existing.data.qty, filledQty: parent.data?.filled_qty ?? existing.data.filled_qty, orderId: order_id, status: parentStatus ?? 'unknown', terminal: terminalStatus(parentStatus) }); await rememberManualOrder(context, { symbol: existing.data.symbol, clientOrderId: after.data?.client_order_id ?? successorId, side: existing.data.side, qty: successorQty, filledQty: after.data?.filled_qty, orderId: after.data?.id ?? linkedId ?? null, status: after.ok ? after.data?.status : 'unknown', terminal: terminalStatus(after.data?.status) }); return { provenance, owner: provenance, client_order_id: replacement.client_order_id, brokerResponse, after, manualOwnership: await currentManualOwnership(context) }; })),
  tool('broker_account', 'Read the bound V5 PAPER account, including buying power.', base, (args, context) => requestFor(context, '/v2/account')),
  tool('broker_orders', 'Read orders with supported status, date, symbol, side, and pagination filters.', { ...base, ...orderFilterSchema }, (filters, context) => {
    if ((filters.before_order_id || filters.after_order_id) && (filters.after || filters.until)) throw Object.assign(new Error('Order ID pagination cannot be combined with after or until.'), { code: 'INVALID_INPUT' });
    if (filters.before_order_id && filters.after_order_id) throw Object.assign(new Error('Specify before_order_id or after_order_id, not both.'), { code: 'INVALID_INPUT' });
    return requestFor(context, `/v2/orders${params(filters)}`);
  }),
  tool('broker_order', 'Read one order by order ID without changing local ownership state.', { ...base, order_id: orderId }, ({ order_id }, context) => requestFor(context, orderIdPath(order_id))),
  tool('broker_order_by_client_id', 'Read one exact order by its client_order_id without changing local ownership state.', { client_order_id: str }, ({ client_order_id }, context) => requestFor(context, `/v2/orders:by_client_order_id${params({ client_order_id }, new Set(['client_order_id']))}`)),
  tool('broker_fills', 'Read fill activities with supported date, order, and pagination filters.', { ...base, ...fillFilterSchema }, ({ ...filters }, context) => requestFor(context, `/v2/account/activities/FILL${params(filters)}`)),
  tool('broker_positions', 'Read all open positions.', base, (args, context) => requestFor(context, '/v2/positions')),
  tool('broker_position', 'Read one open position by symbol or asset ID.', { ...base, symbol: str }, ({ symbol }, context) => requestFor(context, positionPath(symbol))),
  tool('broker_option_contracts', 'Search option contracts by underlying, expiry, type, and strike filters.', { ...base, underlying_symbols: optional(str), status: optional(z.enum(['active', 'inactive'])), expiration_date: optional(str), expiration_date_gte: optional(str), expiration_date_lte: optional(str), root_symbol: optional(str), type: optional(z.enum(['call', 'put'])), style: optional(z.enum(['american', 'european'])), strike_price_gte: optional(num), strike_price_lte: optional(num), show_deliverables: optional(z.boolean()), ppind: optional(z.boolean()), limit: optional(z.number().int().min(1).max(10000)), page_token: optional(str) }, ({ ...filters }, context) => requestFor(context, `/v2/options/contracts${params(filters)}`)),
  tool('broker_option_snapshots', 'Read latest trades, OPRA quotes, and greeks for option contract symbols.', { ...base, symbols: str, feed: optional(optionFeed) }, ({ symbols, feed = 'opra' }, context) => requestFor(context, `/v1beta1/options/snapshots${params({ symbols, feed }, new Set(['symbols', 'feed']))}`)),
  tool('broker_option_quotes', 'Read latest OPRA quotes for option contract symbols.', { ...base, symbols: str, feed: optional(optionFeed) }, ({ symbols, feed = 'opra' }, context) => requestFor(context, `/v1beta1/options/quotes/latest${params({ symbols, feed }, new Set(['symbols', 'feed']))}`)),
  tool('broker_option_trades', 'Read latest OPRA trades for option contract symbols.', { ...base, symbols: str, feed: optional(optionFeed) }, ({ symbols, feed = 'opra' }, context) => requestFor(context, `/v1beta1/options/trades/latest${params({ symbols, feed }, new Set(['symbols', 'feed']))}`)),
  tool('broker_option_historical_bars', 'Read historical bars for option contract symbols.', { ...optionHistoryFilters, timeframe: str }, (filters, context) => requestFor(context, `/v1beta1/options/bars${params(filters)}`)),
  tool('broker_option_historical_quotes', 'Read historical OPRA quotes for option contract symbols.', { ...optionQuoteHistoryFilters, feed: optional(optionFeed) }, ({ ...filters }, context) => requestFor(context, `/v1beta1/options/quotes${params({ ...filters, feed: filters.feed ?? 'opra' })}`)),
  tool('broker_option_historical_trades', 'Read historical option trades for option contract symbols.', { ...base, ...optionHistoryFilters }, ({ ...filters }, context) => requestFor(context, `/v1beta1/options/trades${params(filters)}`)),
  tool('broker_stock_snapshot', 'Read the latest stock trade, SIP quote, and bars for one symbol.', { ...base, symbol: str, feed: optional(stockFeed) }, ({ symbol, feed = 'sip' }, context) => requestFor(context, `/v2/stocks/${encodeURIComponent(symbol)}/snapshot${params({ feed }, new Set(['feed']))}`)),
  tool('broker_stock_quote', 'Read the latest SIP quote for one symbol.', { ...base, symbol: str, feed: optional(stockFeed) }, ({ symbol, feed = 'sip' }, context) => requestFor(context, `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest${params({ feed }, new Set(['feed']))}`)),
  tool('broker_stock_trade', 'Read the latest SIP trade for one symbol.', { ...base, symbol: str, feed: optional(stockFeed) }, ({ symbol, feed = 'sip' }, context) => requestFor(context, `/v2/stocks/trades/latest${params({ symbols: symbol, feed }, new Set(['symbols', 'feed']))}`)),
  tool('broker_stock_historical_bars', 'Read historical SIP bars for stock symbols.', { ...base, ...stockHistoryFilters, timeframe: str, adjustment: optional(str) }, ({ ...filters }, context) => requestFor(context, `/v2/stocks/bars${params({ ...filters, feed: filters.feed ?? 'sip' })}`)),
  tool('broker_stock_historical_quotes', 'Read historical SIP quotes for stock symbols.', { ...base, ...stockHistoryFilters }, ({ ...filters }, context) => requestFor(context, `/v2/stocks/quotes${params({ ...filters, feed: filters.feed ?? 'sip' })}`)),
  tool('broker_stock_historical_trades', 'Read historical SIP trades for stock symbols.', { ...base, ...stockHistoryFilters }, ({ ...filters }, context) => requestFor(context, `/v2/stocks/trades${params({ ...filters, feed: filters.feed ?? 'sip' })}`)),
  tool('broker_clock', 'Read the US equity market clock.', base, (args, context) => requestFor(context, '/v2/clock')),
  tool('broker_calendar', 'Read market calendar days, optionally bounded by inclusive start and end dates.', { ...base, start: optional(str), end: optional(str) }, ({ start, end }, context) => requestFor(context, `/v2/calendar${params({ start, end }, new Set(['start', 'end']))}`)),
];
