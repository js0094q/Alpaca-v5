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
const ambiguousMutationError = (error) => {
  const status = Number(error?.httpStatus);
  return !Number.isInteger(status) || status >= 500 || [404, 408, 409, 429].includes(status) || /duplicate|already.*(?:exist|use)|must be unique/i.test(error?.message ?? '');
};

export function createPositions({ broker, onExit = () => {}, onExecutionIssue = () => {}, onState = () => {}, onTelemetry = () => {}, now = () => Date.now(), nowMono = () => Date.now(), getDayStartCapital = () => null }) {
  const telemetry = (type, fields) => { try { onTelemetry({ type, at: new Date(Number(now())).toISOString(), ...fields }); } catch {} };
  const decision = (kind, trade, quote, bid) => telemetry('decision', { kind, tradeId: trade.tradeId, symbol: trade.symbol, bid: bid / 100, ask: finite(quote?.ask), quoteTimestamp: quote?.timestamp ?? null, entryPrice: trade.entryPrice, anchorBid: trade.anchorBid, profitFloor: trade.profitFloor });
  const trades = new Map();
  const orders = new Map();
  const latestQuotes = new Map();
  const terminalOrders = new Set();
  const observedFills = new Map();
  const successors = new Map();
  const cancelRequested = new Set();
  const executionIssues = new Map();
  const mutationRecovery = new Map();
  const externalSells = new Set();
  const trackOrder = (trade, id) => {
    if (!id) return;
    trade.orderIds.add(id);
    orders.set(id, trade);
  };
  const issue = (trade, reason, details) => {
    const data = { reason, tradeId: trade.tradeId, symbol: trade.symbol, ...details };
    executionIssues.set(`${reason}:${details.orderId ?? details.logicalSellId ?? trade.tradeId}`, data);
    onExecutionIssue(data);
  };
  const resolveIssue = (reason, orderId) => {
    const key = `${reason}:${orderId}`;
    const resolved = executionIssues.get(key);
    if (resolved) { executionIssues.delete(key); onExecutionIssue({ ...resolved, resolved: true }); }
  };
  const knownFilled = (trade) => [...trade.orderIds].reduce((sum, id) => sum + (observedFills.get(id)?.qty ?? 0), 0);
  const clearMutation = (trade, pending) => {
    if (mutationRecovery.get(trade.tradeId) !== pending) return false;
    mutationRecovery.delete(trade.tradeId);
    resolveIssue(pending.reason, pending.orderId ?? trade.logicalSellId);
    return true;
  };
  const reconcileMutation = async (trade, pending) => {
    if (mutationRecovery.get(trade.tradeId) !== pending || pending.reading || nowMono() < pending.nextReadAt) return;
    pending.reading = true;
    pending.nextReadAt = nowMono() + 5_000;
    try {
      if (pending.kind === 'cancel') {
        if (await confirmTerminalCancel(trade, pending.orderId)) {
          markTerminal(pending.orderId);
          clearMutation(trade, pending);
          notify(trade);
        }
        return;
      }
      let order;
      let replacedParentId = null;
      if (pending.kind === 'submit') {
        order = await broker.getOrderByClientOrderId(trade.logicalSellId);
        if (!order || order.client_order_id !== trade.logicalSellId || order.symbol !== trade.symbol || order.side !== 'sell') return;
      } else {
        order = await broker.getOrder(pending.orderId);
        if (!order || order.id !== pending.orderId || order.symbol !== trade.symbol || order.side !== 'sell') return;
        if (pending.kind === 'replace') {
          if (!order.replaced_by) return;
          const child = await broker.getOrder(order.replaced_by);
          if (!child || child.id !== order.replaced_by || child.replaces !== order.id || child.symbol !== trade.symbol || child.side !== 'sell') return;
          replacedParentId = order.id;
          order = child;
        }
      }
      if (pendingMutationIsStale(trade, pending)) return;
      const hasFilledEvidence = order.filled_qty !== null && order.filled_qty !== undefined && order.filled_qty !== '';
      const brokerFilled = hasFilledEvidence ? Number(order.filled_qty) : null;
      const knownQty = knownFilled(trade);
      const orderQty = Number(order.qty);
      const status = String(order.status ?? '').toLowerCase();
      const openStatus = ['new', 'accepted', 'pending_new', 'partially_filled'].includes(status);
      if (pending.kind === 'replace' && replacedParentId && trade.remainingQty <= 0 && openStatus &&
          (!Number.isFinite(brokerFilled) || brokerFilled !== knownQty)) {
        trackOrder(trade, replacedParentId);
        trackOrder(trade, order.id);
        successors.set(replacedParentId, order.id);
        markTerminal(replacedParentId);
        trade.orderId = order.id;
        cancelClosedOrders(trade);
        notify(trade);
        return;
      }
      if (!Number.isFinite(brokerFilled) || brokerFilled !== knownQty ||
          (orderQty !== trade.remainingQty && orderQty !== trade.remainingQty + knownQty)) return;
      if (!['new', 'accepted', 'pending_new', 'partially_filled', 'filled', 'canceled', 'cancelled', 'rejected', 'expired', 'done'].includes(status)) return;
      if (status === 'filled' && brokerFilled === 0) return;
      trackOrder(trade, order.id);
      trade.orderId = order.id;
      if (replacedParentId) { successors.set(replacedParentId, order.id); markTerminal(replacedParentId); }
      if (['filled', 'canceled', 'cancelled', 'rejected', 'expired', 'done'].includes(status)) markTerminal(order.id);
      if (clearMutation(trade, pending)) {
        if (trade.remainingQty <= 0) cancelClosedOrders(trade);
        notify(trade);
      }
    } catch {
      // An absent or incomplete lookup is not evidence that a mutation failed.
    } finally {
      pending.reading = false;
      if (mutationRecovery.get(trade.tradeId) === pending) pending.nextReadAt = Math.max(pending.nextReadAt, nowMono() + 5_000);
    }
  };
  const pendingMutationIsStale = (trade, pending) => mutationRecovery.get(trade.tradeId) !== pending;
  const holdMutation = (trade, kind, orderId, error) => {
    const reason = kind === 'replace' ? 'SELL_REPLACE_UNKNOWN' : kind === 'cancel' ? 'SELL_CANCEL_FAILED' : 'SELL_SUBMIT_UNKNOWN';
    const pending = { kind, orderId, reason, reading: false, nextReadAt: nowMono() };
    mutationRecovery.set(trade.tradeId, pending);
    issue(trade, reason, { orderId, ...(kind === 'submit' ? { logicalSellId: trade.logicalSellId } : {}), httpStatus: error?.httpStatus });
    void reconcileMutation(trade, pending);
  };
  const watchCancel = (trade, id, error = null) => {
    if (mutationRecovery.has(trade.tradeId)) return;
    const pending = { kind: 'cancel', orderId: id, reason: 'SELL_CANCEL_FAILED', reading: false, nextReadAt: nowMono() };
    mutationRecovery.set(trade.tradeId, pending);
    if (error) issue(trade, pending.reason, { orderId: id, httpStatus: error?.httpStatus });
    void reconcileMutation(trade, pending);
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
        if (!terminalOrders.has(id)) watchCancel(trade, id);
        notify(trade);
      }).catch(async (error) => {
        if (!terminalOrders.has(id)) {
          try {
            if (await confirmTerminalCancel(trade, id)) {
              markTerminal(id);
            }
          } catch { /* Missing authoritative evidence keeps the cancellation blocker. */ }
        }
        if (!terminalOrders.has(id)) watchCancel(trade, id, error);
        notify(trade);
      });
    }
  }

  const snapshot = (trade) => {
    const { orderIds, seenSellExecutions, ...publicTrade } = trade;
    return publicTrade;
  };
  const notify = (trade) => onState(snapshot(trade));

  const latch = (trade, quote = trade.quote, acceptedAt = trade.quoteReceivedAtMs) => {
    if (!trade.sellDecisionCaptured) {
      trade.sellDecisionBid = finite(quote?.bid);
      trade.sellDecisionTimestamp = quote?.timestamp ?? null;
      trade.sellDecisionSetAtMs = Number.isFinite(acceptedAt) ? acceptedAt : null;
      trade.sellDecisionCaptured = true;
    }
    trade.sellLatched = true;
    trade.logicalSellId ||= `v5-sell-${randomUUID()}`;
    notify(trade);
    pump(trade);
  };

  function evaluate(trade, quote, acceptedAt) {
    if (trade.remainingQty <= 0) return;
    const bid = cents(quote.bid);
    const entry = cents(trade.entryPrice);
    if (bid === null || bid <= 0 || entry === null) return;

    trade.mfeCents = Math.max(trade.mfeCents ?? 0, bid - entry);
    trade.maeCents = Math.max(trade.maeCents ?? 0, entry - bid);
    if (trade.sellLatched || trade.reconciling) { notify(trade); return; }
    const capital = finite(getDayStartCapital());
    if (capital !== null && capital > 0 && entry - bid >= capital * 0.25) {
      decision('stop_latch', trade, quote, bid);
      trade.exitReason = 'HARD_STOP';
      notify(trade);
      latch(trade, quote, Number.isFinite(acceptedAt) ? acceptedAt : null);
      return;
    }
    notify(trade);
  }

  function pump(trade) {
    if (!trade.sellLatched || trade.remainingQty <= 0 || trade.inFlight || terminalOrders.has(trade.orderId) || externalSells.has(trade.symbol) || trade.reconciling) return;
    if (mutationRecovery.has(trade.tradeId)) return;
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
      if (ambiguousMutationError(error) && !(replacedOrderId ? successors.has(replacedOrderId) : trade.orderId && trade.orderIds.has(trade.orderId))) {
        holdMutation(trade, replacedOrderId ? 'replace' : 'submit', replacedOrderId, error);
      }
      trade.lastSubmittedPrice = null;
      trade.lastSubmittedQty = null;
      notify(trade);
    });
  }

  function accountSellFill(trade, update, actionSource = 'V5_AUTO') {
    if (update.executionId && trade.seenSellExecutions.has(update.executionId)) return false;
    const filledQty = Number(update.fillQty);
    const quantity = Math.max(0, Math.min(trade.remainingQty, filledQty || 0));
    const price = finite(update.fillPrice);
    if (!Number.isFinite(filledQty) || filledQty <= 0 || price === null) return false;
    if (update.executionId) trade.seenSellExecutions.add(update.executionId);
    const observed = observedFills.get(update.orderId) ?? { qty: 0, value: 0 };
    observedFills.set(update.orderId, { qty: observed.qty + filledQty, value: observed.value + filledQty * price, timestamp: update.timestamp });
    if (filledQty > trade.remainingQty) issue(trade, 'SELL_OVERFILL', { orderId: update.orderId, executionId: update.executionId, excessQty: filledQty - trade.remainingQty, fillQty: filledQty, fillPrice: price, timestamp: update.timestamp });
    if (quantity <= 0) return false;
    trade.remainingQty -= quantity;
    const premiumPnlPerShare = trade.entryPrice === null ? null : (cents(price) - cents(trade.entryPrice)) * quantity / 100;
    const realizedPnlUsd = premiumPnlPerShare === null || !Number.isFinite(trade.contractSize) || trade.contractSize <= 0 ? null : Math.round(premiumPnlPerShare * trade.contractSize * 100) / 100;
    cancelClosedOrders(trade);
    notify(trade);
    onExit({
      executionId: update.executionId, tradeId: trade.tradeId, tradeSetId: trade.tradeSetId, entrySetId: trade.tradeSetId,
      signalId: trade.signalId, actionSource, exitReason: actionSource === 'EXTERNAL_MANUAL_EXIT' ? actionSource : trade.exitReason,
      symbol: trade.symbol, qty: quantity, price, sellOrderId: update.orderId ?? null,
      logicalSellId: trade.logicalSellId ?? null, sellDecisionBid: finite(trade.sellDecisionBid),
      sellDecisionTimestamp: trade.sellDecisionTimestamp ?? null, sellDecisionSetAtMs: finite(trade.sellDecisionSetAtMs),
      sellFillVsDecisionBid: finite(trade.sellDecisionBid) === null ? null : price - finite(trade.sellDecisionBid),
      entryPrice: trade.entryPrice, premiumPnlPerShare, contractSize: trade.contractSize, contractSizeSource: trade.contractSizeSource,
      realizedPnlUsd, mfeCents: trade.mfeCents ?? 0, maeCents: trade.maeCents ?? 0,
      timestamp: update.timestamp ?? nowMono()
    });
    if (trade.remainingQty <= 0) { trade.remainingQty = 0; trade.orderId = null; trade.reconciling = false; notify(trade); }
    else { trade.lastSubmittedPrice = null; trade.lastSubmittedQty = null; pump(trade); }
    return true;
  }

  function adoptExternalFill(fill) {
    const trade = trades.get(fill?.tradeId);
    if (!trade || trade.entryPrice === null || trade.symbol !== fill.symbol || !fill.executionId || !Number.isFinite(epochMs(fill.timestamp)) ||
        epochMs(fill.timestamp) < trade.fillTimestampMs || finite(fill.fillPrice) === null || Number(fill.fillPrice) < 0 ||
        !(trade.remainingQty > 0) || Number(fill.fillQty) !== trade.remainingQty) {
      if (trade) trade.reconciling = true;
      if (trade) notify(trade);
      return { adopted: false, reason: 'RECONCILING', trade: trade ? snapshot(trade) : null };
    }
    const unresolved = trade.inFlight || mutationRecovery.has(trade.tradeId) || [...trade.orderIds].some((id) => !terminalOrders.has(id));
    if (unresolved) { trade.reconciling = true; notify(trade); return { adopted: false, reason: 'RECONCILING', trade: snapshot(trade) }; }
    const adopted = accountSellFill(trade, { ...fill, orderId: fill.orderId ?? `external:${fill.executionId}` }, 'EXTERNAL_MANUAL_EXIT');
    return adopted ? { adopted: true, trade: snapshot(trade) } : { adopted: false, reason: 'RECONCILING', trade: snapshot(trade) };
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
      entryClientOrderId: fill.entryClientOrderId ?? null,
      entryOrderId: fill.entryOrderId ?? null,
      entryDecisionAsk: finite(fill.entryDecisionAsk),
      entryDecisionTimestamp: fill.entryDecisionTimestamp ?? null,
      entryDecisionAt: fill.entryDecisionAt ?? null,
      anchorBid: null,
      anchorSetAtMs: null,
      anchorSourceTimestamp: null,
      sellDecisionBid: null,
      sellDecisionTimestamp: null,
      sellDecisionSetAtMs: null,
      sellDecisionCaptured: false,
      remainingQty: 1,
      profitFloor: null,
      mfeCents: 0,
      maeCents: 0,
      exitReason: null,
      reconciling: false,
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
    telemetry('quote', { symbol: quote.symbol, bid: Number(quote.bid), ask: finite(quote.ask), quoteTimestamp: quote.timestamp ?? null });
    for (const trade of trades.values()) {
      if (trade.symbol !== quote.symbol || trade.remainingQty <= 0) continue;
      trade.quote = { ...acceptedQuote.quote };
      trade.quoteReceivedAtMs = acceptedQuote.acceptedAt;
      trade.quoteReceivedMonoMs = Number.isFinite(acceptedQuote.acceptedMono) ? acceptedQuote.acceptedMono : null;
      evaluate(trade, trade.quote, acceptedQuote.acceptedAt);
      if (trade.sellLatched) pump(trade);
    }
  }

  const tradeForOrderUpdate = (update) => orders.get(update?.orderId) ?? orders.get(update?.replaces) ?? orders.get(update?.replacedBy) ??
    (update?.clientOrderId ? [...trades.values()].find((trade) => trade.logicalSellId === update.clientOrderId) : undefined);

  function onOrderUpdate(update) {
    const trade = tradeForOrderUpdate(update);
    if (!trade) return;
    if (!trade.orderId && update.orderId && update.clientOrderId === trade.logicalSellId) trade.orderId = update.orderId;
    const pending = mutationRecovery.get(trade.tradeId);
    trackOrder(trade, update.orderId);
    trackOrder(trade, update.replacedBy);
    trackOrder(trade, update.replaces);
    if (['fill', 'canceled', 'rejected', 'expired', 'replaced'].includes(update.event)) markTerminal(update.orderId);
    if (!update.event && Number(update.fillQty) > 0 && Number(update.fillQty) >= trade.remainingQty) markTerminal(update.orderId);
    if (update.replacedBy) {
      successors.set(update.orderId, update.replacedBy);
      if (trade.orderId === update.orderId) trade.orderId = update.replacedBy;
      if (pending?.kind === 'replace' && pending.orderId === update.orderId) clearMutation(trade, pending);
      else resolveIssue('SELL_REPLACE_UNKNOWN', update.orderId);
    }
    if (update.replaces) {
      successors.set(update.replaces, update.orderId);
      if (trade.orderId === update.replaces) trade.orderId = update.orderId;
      if (pending?.kind === 'replace' && pending.orderId === update.replaces) clearMutation(trade, pending);
      else resolveIssue('SELL_REPLACE_UNKNOWN', update.replaces);
    }
    if (pending?.kind === 'submit' && update.clientOrderId === trade.logicalSellId && update.orderId) {
      trade.orderId = update.orderId;
      clearMutation(trade, pending);
    } else if (pending?.kind === 'replace' && update.replaces === pending.orderId && update.orderId) {
      trade.orderId = update.orderId;
      clearMutation(trade, pending);
    } else if (pending?.kind === 'replace' && update.orderId === pending.orderId && ['order_replace_rejected', 'replace_rejected'].includes(String(update.event ?? '').toLowerCase())) {
      clearMutation(trade, pending);
    } else if (pending?.kind === 'cancel' && update.orderId === pending.orderId && ['canceled', 'cancelled', 'rejected', 'expired', 'fill'].includes(String(update.event ?? '').toLowerCase())) {
      clearMutation(trade, pending);
    }
    cancelClosedOrders(trade);
    notify(trade);
    accountSellFill(trade, update);
  }

  function restoreTrade(state) {
    if (!state?.tradeId || !state.symbol || cents(state.entryPrice) === null) throw new TypeError('invalid trade state');
    const fillTimestampMs = Number.isFinite(state.fillTimestampMs) ? state.fillTimestampMs : Number(now());
    const trade = {
      ...state,
      fillTimestampMs: Number.isFinite(fillTimestampMs) ? fillTimestampMs : undefined,
      mfeCents: Number.isFinite(state.mfeCents) ? state.mfeCents : 0,
      maeCents: Number.isFinite(state.maeCents) ? state.maeCents : 0,
      reconciling: state.reconciling === true,
      anchorBid: state.anchorBid ?? null,
      sellDecisionBid: state.sellDecisionBid ?? null,
      sellDecisionTimestamp: state.sellDecisionTimestamp ?? null,
      sellDecisionSetAtMs: state.sellDecisionSetAtMs ?? null,
      sellDecisionCaptured: state.sellDecisionBid !== null && state.sellDecisionBid !== undefined,
      anchorSetAtMs: state.anchorSetAtMs ?? null,
      anchorSourceTimestamp: state.anchorSourceTimestamp ?? null,
      profitFloor: state.profitFloor ?? null,
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
      sellDecisionBid: null, sellDecisionTimestamp: null, sellDecisionSetAtMs: null,
      sellDecisionCaptured: false,
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
      if (trade.remainingQty > 0 && !trade.sellLatched && !trade.reconciling && !externalSells.has(trade.symbol)) latch(trade);
    }
  }

  return {
    onFill,
    adoptExternalFill,
    setExternalSell: (symbol, active) => { if (active) externalSells.add(symbol); else externalSells.delete(symbol); },
    markReconciling: (tradeId) => { const trade = trades.get(tradeId); if (!trade) return false; trade.reconciling = true; notify(trade); return true; },
    liquidate,
    onQuote,
    onOrderUpdate,
    isKnownOrderUpdate: (update) => Boolean(tradeForOrderUpdate(update)),
    reconcilePending: () => { for (const trade of trades.values()) { const pending = mutationRecovery.get(trade.tradeId); if (pending) void reconcileMutation(trade, pending); else for (const id of trade.orderIds) if (cancelRequested.has(id) && !terminalOrders.has(id)) { watchCancel(trade, id); break; } } },
    hasPendingMutation: (tradeId) => mutationRecovery.has(tradeId),
    hasPendingExecution: () => executionIssues.size > 0 || [...trades.values()].some((trade) => trade.remainingQty <= 0 && (trade.inFlight || [...trade.orderIds].some((id) => !terminalOrders.has(id)))),
    getTrades: () => [...trades.values()].map(snapshot),
    restoreTrade,
    clearAlreadyClosed,
    recoverLostPlace
  };
}
