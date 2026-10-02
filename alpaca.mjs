const json = async (response) => { const body = await response.text(); if (!response.ok) { let details; try { details = JSON.parse(body); } catch {} const error = new Error(details?.message ?? body ?? 'Alpaca request failed'); error.httpStatus = response.status; error.code = details?.code; throw error; } return body ? JSON.parse(body) : null; };

export function createAlpacaBroker({ key, secret, baseUrl, fetchImpl = fetch }) {
  if (!key || !secret) throw new TypeError('Alpaca credentials are required');
  if (!['https://paper-api.alpaca.markets', 'https://api.alpaca.markets'].includes(baseUrl)) throw new Error('Unsupported Alpaca API URL');
  const request = (path, options = {}) => {
    return fetchImpl(`${baseUrl}${path}`, { ...options, headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, 'content-type': 'application/json', ...(options.headers ?? {}) } }).then(json);
  };
  return {
    submitOrder: (o) => request('/v2/orders', { method: 'POST', body: JSON.stringify({ symbol: o.symbol, qty: o.qty, side: o.side, type: 'limit', limit_price: o.limitPrice, time_in_force: 'day', client_order_id: o.clientOrderId, ...(o.positionIntent ? { position_intent: o.positionIntent } : {}) }) }).then((x) => ({ id: x.id, status: x.status, clientOrderId: x.client_order_id })),
    replaceOrder: (id, o) => request(`/v2/orders/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ limit_price: o.limitPrice }) }).then((x) => ({ id: x.id, status: x.status, clientOrderId: x.client_order_id })),
    cancelOrder: (id) => request(`/v2/orders/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => undefined),
    getOrder: (id) => request(`/v2/orders/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5000) }),
    getOrderFills: (id) => request(`/v2/account/activities/FILL?order_id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5000) }),
    getOrderByClientOrderId: (clientOrderId) => request(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`, { signal: AbortSignal.timeout(5000) }),
    inspectCurrentState: async () => ({
      account: await request('/v2/account', { signal: AbortSignal.timeout(5000) }),
      positions: await request('/v2/positions', { signal: AbortSignal.timeout(5000) }),
      orders: await request('/v2/orders?status=open&nested=true&direction=asc', { signal: AbortSignal.timeout(5000) }),
    }),
  };
}

export function normalizeTradeUpdate(frame) {
  const data = frame.data ?? frame;
  const order = data.order ?? frame.order ?? {};
  const event = data.event ?? frame.event;
  const fill = event === 'fill' || event === 'partial_fill';
  if (fill && (data.execution_id == null || data.qty == null || data.price == null)) throw new TypeError('fill update is missing execution data');
  return { executionId: data.execution_id, orderId: order.id, clientOrderId: order.client_order_id, symbol: order.symbol, side: order.side, event, fillQty: fill ? Number(data.qty) : 0, fillPrice: fill ? Number(data.price) : undefined, timestamp: data.timestamp, replacedBy: order.replaced_by, replaces: order.replaces };
}
