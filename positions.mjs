import { randomUUID } from 'node:crypto';

const finite = (value) => {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
};
const cents = (value) => {
  const number = finite(value);
  return number === null ? null : Math.round(number * 100);
};

const epochMs = (value) => {
  if (Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const fraction = value.match(/\.(\d+)(?=Z|[+-]\d\d:?\d\d$)/)?.[1];
  if (!fraction) return parsed;
  const discarded = fraction.slice(3);
  // Broker sub-millisecond fills round up so loss eligibility never starts early.
  return parsed + (discarded && /[1-9]/.test(discarded) ? 1 : 0);
};

export function createPositions({ broker, onExit = () => {}, onExecutionIssue = () => {}, onState = () => {}, now = () => Date.now(), nowMono = () => Date.now() }) {
  const trades = new Map();
  const orders = new Map();
  const latestQuotes = new Map();
  const terminalOrders = new Set();
  const observedFills = new Map();
  const successors = new Map();
  const cancelRequested = new Set();
  const executionIssues = new Map();
  const trackOrder = (trade, id) => {
    if (!id) return;
    trade.orderIds.add(id);
    orders.set(id, trade);
  };
  const issue = (trade, reason, details) => {
    const data = { reason, tradeId: trade.tradeId, symbol: trade.symbol, ...details };
    executionIssues.set(`${reason}:${details.orderId}`, data);
    onExecutionIssue(data);
  };
  const resolveIssue = (reason, orderId) => {
    const key = `${reason}:${orderId}`;
    const resolved = executionIssues.get(key);
    if (resolved) { executionIssues.delete(key); onExecutionIssue({ ...resolved, resolved: true }); }
  };
  function markTerminal(orderId) {
    terminalOrders.add(orderId);
    resolveIssue('SELL_CANCEL_FAILED', orderId);
  }
  async function confirmTerminalCancel(trade, id) {
    if (typeof broker.getOrder !== 'function') return false;
    const order = await broker.getOrder(id);
    if (order?.id !== id || order.symbol !== trade.symbol || order.side !== 'sell' || order.replaced_by) return false;
    if (order.status === 'filled' && typeof broker.getOrderFills === 'function' && typeof broker.inspectCurrentState === 'function') {
      // Alpaca can show an inherited parent fill on a replacement that never executed.
      // Require no independent child activity and current broker flatness before clearing it.
      const [fills, current] = await Promise.all([broker.getOrderFills(id), broker.inspectCurrentState()]);
      if (Array.isArray(fills) && fills.length === 0 && Array.isArray(current?.positions) && Array.isArray(current?.orders) &&
          current.positions.every((position) => position.symbol !== trade.symbol || Number(position.qty ?? position.quantity) === 0) &&
          current.orders.every((openOrder) => openOrder.symbol !== trade.symbol)) return true;
    }
    if (!['rejected', 'canceled', 'expired'].includes(order.status)) return false;
    const filled = finite(order.filled_qty);
    if (filled === 0) return true;
    // Rejected replacements can inherit their filled parent's cumulative fields.
    // These snapshots prove terminal lineage; only execution events produce exits.
    const parentId = order.replaces;
    const observed = observedFills.get(parentId);
    if (order.status !== 'rejected' || !(filled > 0) || !parentId || successors.get(parentId) !== id || !terminalOrders.has(parentId) || observed?.qty !== filled || observed.timestamp !== order.filled_at || Math.abs(observed.value / filled - finite(order.filled_avg_price)) > 1e-9) return false;
    const parent = await broker.getOrder(parentId);
    return parent?.id === parentId && parent.symbol === trade.symbol && parent.side === 'sell' && parent.status === 'filled' &&
      finite(parent.filled_qty) === filled && finite(parent.filled_avg_price) !== null && finite(parent.filled_avg_price) === finite(order.filled_avg_price) &&
      typeof parent.filled_at === 'string' && Number.isFinite(Date.parse(parent.filled_at)) && parent.filled_at === order.filled_at;
  }
  function cancelClosedOrders(trade) {
    if (trade.remainingQty > 0) return;
    for (const id of trade.orderIds) {
      if (terminalOrders.has(id) || cancelRequested.has(id)) continue;
      cancelRequested.add(id);
      Promise.resolve().then(() => broker.cancelOrder(id)).then(() => {
        // HTTP acceptance is not terminal: retain the order until its stream event.
        notify(trade);
      }).catch(async (error) => {
        if (!terminalOrders.has(id)) {
          try {
            if (await confirmTerminalCancel(trade, id)) {
              markTerminal(id);
            }
          } catch { /* Missing authoritative evidence keeps the cancellation blocker. */ }
        }
        if (!terminalOrders.has(id)) issue(trade, 'SELL_CANCEL_FAILED', { orderId: id, httpStatus: error?.httpStatus });
        notify(trade);
      });
    }
  }

  const snapshot = (trade) => {
    const { orderIds, seenSellExecutions, ...publicTrade } = trade;
    return publicTrade;
  };
  const notify = (trade) => onState(snapshot(trade));

  const referenceCents = (trade) => {
    const entry = cents(trade.entryPrice);
    const anchor = cents(trade.anchorBid);
    return entry === null || anchor === null ? null : Math.max(entry, anchor);
  };
  const latch = (trade) => {
    trade.sellLatched = true;
    trade.logicalSellId ||= `v5-sell-${randomUUID()}`;
    notify(trade);
    pump(trade);
  };

  function evaluate(trade, quote, acceptedAt) {
    if (trade.remainingQty <= 0 || trade.sellLatched) return;
    const bid = cents(quote.bid);
    const entry = cents(trade.entryPrice);
    if (bid === null || bid <= 0 || entry === null) return;

    const evaluatedAt = Number.isFinite(acceptedAt) ? acceptedAt : null;
    const graceEndsAt = Number.isFinite(trade.fillTimestampMs) ? trade.fillTimestampMs + 10_000 : null;
    let anchorQuote = false;
    if (trade.anchorBid === null) {
      if (graceEndsAt === null || evaluatedAt === null || evaluatedAt < graceEndsAt) {
        return;
      }
      trade.anchorBid = bid / 100;
      trade.anchorSetAtMs = evaluatedAt;
      trade.anchorSourceTimestamp = quote.timestamp ?? null;
      anchorQuote = true;
      notify(trade);
    }

    const reference = referenceCents(trade);
    if (bid * 10 <= reference * 9) {
      latch(trade);
      return;
    }
    if (anchorQuote) return;
    const floor = cents(trade.profitFloor);
    if (floor === null && bid >= reference + 2) {
      trade.profitFloor = (bid - 4) / 100;
      notify(trade);
      return;
    }
    if (floor !== null && bid - 4 > floor) {
      trade.profitFloor = (bid - 4) / 100;
      notify(trade);
    }
    if (floor !== null && bid < cents(trade.profitFloor)) {
      latch(trade);
    }
  }

  function pump(trade) {
    if (!trade.sellLatched || trade.remainingQty <= 0 || trade.inFlight || terminalOrders.has(trade.orderId)) return;
    if ([...executionIssues.values()].some((entry) => entry.tradeId === trade.tradeId && entry.reason === 'SELL_REPLACE_UNKNOWN')) return;
    const bid = finite(trade.quote?.bid);
    if (bid === null) return;
    if (trade.orderId && trade.lastSubmittedPrice === bid && trade.lastSubmittedQty === trade.remainingQty) return;

    trade.inFlight = true;
    const quantity = trade.remainingQty;
    const replacedOrderId = trade.orderId;
    const request = trade.orderId
      ? broker.replaceOrder(trade.orderId, { qty: quantity, limitPrice: bid })
      : broker.submitOrder({
        symbol: trade.symbol,
        qty: quantity,
        side: 'sell',
        positionIntent: 'sell_to_close',
        limitPrice: bid,
        clientOrderId: trade.logicalSellId
      });

    Promise.resolve(request).then((result) => {
      trade.inFlight = false;
      trackOrder(trade, result?.id);
      if (replacedOrderId && result?.id && replacedOrderId !== result.id) successors.set(replacedOrderId, result.id);
      if (['filled', 'rejected', 'canceled', 'expired', 'replaced'].includes(result?.status)) markTerminal(result.id);
      if (trade.remainingQty <= 0) { cancelClosedOrders(trade); notify(trade); return; }
      if (!result?.id || result.status === 'rejected' || result.status === 'canceled') {
        trade.lastSubmittedPrice = null;
        trade.lastSubmittedQty = null;
        return;
      }
      trade.lastSubmittedPrice = bid;
      trade.lastSubmittedQty = quantity;
      if (terminalOrders.has(result.id)) {
        if (result.status === 'filled' && !successors.has(result.id)) trade.orderId = result.id;
        notify(trade);
        return;
      }
      trade.orderId = successors.get(result.id) ?? result.id;
      trade.orderIds.add(result.id);
      orders.set(result.id, trade);
      notify(trade);
      pump(trade);
    }).catch((error) => {
      trade.inFlight = false;
      if (replacedOrderId && !successors.has(replacedOrderId) && !(error?.httpStatus >= 400 && error?.httpStatus < 500 && ![408, 429].includes(error.httpStatus))) {
        issue(trade, 'SELL_REPLACE_UNKNOWN', { orderId: replacedOrderId, httpStatus: error?.httpStatus });
      }
      trade.lastSubmittedPrice = null;
      trade.lastSubmittedQty = null;
      notify(trade);
    });
  }

  function onFill(fill) {
    const fillTimestampMs = epochMs(fill?.timestamp);
    if (!fill?.tradeId || !fill.executionId || !fill.symbol || cents(fill.entryPrice) === null || !Number.isFinite(fillTimestampMs)) {
      throw new TypeError('invalid fill');
    }
    const existing = trades.get(fill.tradeId);
    if (existing) return snapshot(existing);

    const trade = {
      tradeId: fill.tradeId,
      tradeSetId: fill.tradeSetId ?? fill.entrySetId ?? null,
      signalId: fill.signalId ?? null,
      executionId: fill.executionId,
      symbol: fill.symbol,
      entryPrice: finite(fill.entryPrice),
      contractSize: Number.isFinite(fill.contractSize) && fill.contractSize > 0 ? fill.contractSize : null,
      contractSizeSource: fill.contractSizeSource ?? null,
      fillTimestampMs,
      anchorBid: null,
      anchorSetAtMs: null,
      anchorSourceTimestamp: null,
      remainingQty: 1,
      profitFloor: null,
      sellLatched: false,
      logicalSellId: null,
      orderId: null,
      orderIds: new Set(),
      seenSellExecutions: new Set(),
      quote: null,
      lastSubmittedPrice: null,
      lastSubmittedQty: null,
      inFlight: false
    };
    trades.set(trade.tradeId, trade);
    notify(trade);
    const currentQuote = latestQuotes.get(trade.symbol);
    if (currentQuote) {
      trade.quote = { ...currentQuote.quote };
      trade.quoteReceivedAtMs = currentQuote.acceptedAt;
      trade.quoteReceivedMonoMs = currentQuote.acceptedMono ?? null;
      evaluate(trade, trade.quote, currentQuote.acceptedAt);
      if (trade.sellLatched) pump(trade);
    }
    return snapshot(trade);
  }

  function onQuote(quote) {
    if (!quote?.symbol || cents(quote.bid) === null || Number(quote.bid) <= 0) return;
    const acceptedAt = Number(now());
    const acceptedQuote = { quote: { ...quote }, acceptedAt: Number.isFinite(acceptedAt) ? acceptedAt : null, acceptedMono: performance.now() };
    latestQuotes.set(quote.symbol, acceptedQuote);
    for (const trade of trades.values()) {
      if (trade.symbol !== quote.symbol || trade.remainingQty <= 0) continue;
      trade.quote = { ...acceptedQuote.quote };
      trade.quoteReceivedAtMs = acceptedQuote.acceptedAt;
      trade.quoteReceivedMonoMs = Number.isFinite(acceptedQuote.acceptedMono) ? acceptedQuote.acceptedMono : null;
      evaluate(trade, trade.quote, acceptedQuote.acceptedAt);
      if (trade.sellLatched) pump(trade);
    }
  }

  function onOrderUpdate(update) {
    let trade = orders.get(update?.orderId) ?? orders.get(update?.replaces) ?? orders.get(update?.replacedBy);
    if (!trade && update?.clientOrderId) {
      trade = [...trades.values()].find((candidate) => candidate.logicalSellId === update.clientOrderId);
      if (trade && update.orderId) {
        trade.orderIds.add(update.orderId);
        orders.set(update.orderId, trade);
      }
    }
    if (!trade) return;
    trackOrder(trade, update.orderId);
    trackOrder(trade, update.replacedBy);
    trackOrder(trade, update.replaces);
    if (['fill', 'canceled', 'rejected', 'expired', 'replaced'].includes(update.event)) markTerminal(update.orderId);
    if (!update.event && Number(update.fillQty) > 0 && Number(update.fillQty) >= trade.remainingQty) markTerminal(update.orderId);
    if (update.replacedBy) {
      successors.set(update.orderId, update.replacedBy);
      if (trade.orderId === update.orderId) trade.orderId = update.replacedBy;
      resolveIssue('SELL_REPLACE_UNKNOWN', update.orderId);
    }
    if (update.replaces) {
      successors.set(update.replaces, update.orderId);
      if (trade.orderId === update.replaces) trade.orderId = update.orderId;
      resolveIssue('SELL_REPLACE_UNKNOWN', update.replaces);
    }
    cancelClosedOrders(trade);
    notify(trade);
    if (update.executionId && trade.seenSellExecutions.has(update.executionId)) return;

    const filledQty = Number(update.fillQty);
    const quantity = Math.max(0, Math.min(trade.remainingQty, filledQty || 0));
    const price = finite(update.fillPrice);
    if (!Number.isFinite(filledQty) || filledQty <= 0 || price === null) return;
    if (update.executionId) trade.seenSellExecutions.add(update.executionId);
    const observed = observedFills.get(update.orderId) ?? { qty: 0, value: 0 };
    observedFills.set(update.orderId, { qty: observed.qty + filledQty, value: observed.value + filledQty * price, timestamp: update.timestamp });
    if (filledQty > trade.remainingQty) issue(trade, 'SELL_OVERFILL', { orderId: update.orderId, executionId: update.executionId, excessQty: filledQty - trade.remainingQty, fillQty: filledQty, fillPrice: price, timestamp: update.timestamp });
    if (quantity <= 0) return;
    trade.remainingQty -= quantity;
    const premiumPnlPerShare = trade.entryPrice === null ? null : (cents(price) - cents(trade.entryPrice)) * quantity / 100;
    const realizedPnlUsd = premiumPnlPerShare === null || !Number.isFinite(trade.contractSize) || trade.contractSize <= 0 ? null : Math.round(premiumPnlPerShare * trade.contractSize * 100) / 100;
    cancelClosedOrders(trade);
    notify(trade);
    onExit({
      executionId: update.executionId,
      tradeId: trade.tradeId,
      tradeSetId: trade.tradeSetId,
      entrySetId: trade.tradeSetId,
      signalId: trade.signalId,
      actionSource: 'V5_AUTO',
      symbol: trade.symbol,
      qty: quantity,
      price,
      entryPrice: trade.entryPrice,
      premiumPnlPerShare,
      contractSize: trade.contractSize,
      contractSizeSource: trade.contractSizeSource,
      realizedPnlUsd,
      timestamp: update.timestamp ?? nowMono()
    });
    if (trade.remainingQty <= 0) {
      trade.remainingQty = 0;
      trade.orderId = null;
      notify(trade);
    } else {
      trade.lastSubmittedPrice = null;
      trade.lastSubmittedQty = null;
      pump(trade);
    }
  }

  function restoreTrade(state) {
    if (!state?.tradeId || !state.symbol || cents(state.entryPrice) === null) throw new TypeError('invalid trade state');
    const fillTimestampMs = Number.isFinite(state.fillTimestampMs) ? state.fillTimestampMs : Number(now());
    const trade = {
      ...state,
      fillTimestampMs: Number.isFinite(fillTimestampMs) ? fillTimestampMs : undefined,
      anchorBid: state.anchorBid ?? null,
      anchorSetAtMs: state.anchorSetAtMs ?? null,
      anchorSourceTimestamp: state.anchorSourceTimestamp ?? null,
      profitFloor: state.anchorBid == null ? null : state.profitFloor ?? null,
      orderIds: new Set(state.orderId ? [state.orderId] : []),
      seenSellExecutions: new Set(),
      quote: null,
      lastSubmittedPrice: null,
      lastSubmittedQty: null,
      inFlight: false
    };
    trades.set(trade.tradeId, trade);
    if (trade.orderId) orders.set(trade.orderId, trade);
    notify(trade);
    return snapshot(trade);
  }

  function clearAlreadyClosed(tradeId) {
    const trade = trades.get(tradeId);
    if (!trade) return;
    trade.remainingQty = 0;
    trade.sellLatched = true;
    for (const orderId of trade.orderIds) orders.delete(orderId);
    trades.delete(tradeId);
  }

  function recoverLostPlace({ symbol, remainingQty, logicalSellId = null, orderId = null, tradeId = `recovery:${symbol}:${orderId ?? 'uncovered'}` }) {
    if (!symbol || !Number.isFinite(Number(remainingQty)) || Number(remainingQty) <= 0) throw new TypeError('invalid recovery state');
    const trade = {
      tradeId,
      executionId: 'recovery', symbol, entryPrice: null, remainingQty: Number(remainingQty), anchorBid: null, profitFloor: null,
      sellLatched: true, logicalSellId: logicalSellId || `v5-sell-${randomUUID()}`, orderId, orderIds: new Set(orderId ? [orderId] : []), seenSellExecutions: new Set(),
      quote: null, lastSubmittedPrice: null, lastSubmittedQty: null, inFlight: false
    };
    trades.set(trade.tradeId, trade);
    if (orderId) orders.set(orderId, trade);
    notify(trade);
    return snapshot(trade);
  }

  function liquidate() {
    for (const trade of trades.values()) {
      if (trade.remainingQty > 0 && !trade.sellLatched) latch(trade, 'session_liquidation');
    }
  }

  return {
    onFill,
    liquidate,
    onQuote,
    onOrderUpdate,
    hasPendingExecution: () => executionIssues.size > 0 || [...trades.values()].some((trade) => trade.remainingQty <= 0 && (trade.inFlight || [...trade.orderIds].some((id) => !terminalOrders.has(id)))),
    getTrades: () => [...trades.values()].map(snapshot),
    restoreTrade,
    clearAlreadyClosed,
    recoverLostPlace
  };
}
