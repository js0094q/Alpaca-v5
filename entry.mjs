import { randomUUID } from 'node:crypto';

const NO_FILL_MS = 2_000;
const REMAINING_MS = 5_000;
const RECOVERY_READ_MS = 5_000;

const ambiguousMutationError = (error) => {
  const status = Number(error?.httpStatus);
  return !Number.isInteger(status) || status >= 500 || [404, 408, 409, 429].includes(status) || /duplicate|already.*(?:exist|use)|must be unique/i.test(error?.message ?? '');
};

export function createEntry({ broker, getContracts, getQuote, onFill, onState, nowMono, canSubmit = () => true, quantity = 3, strategyCapital = null }) {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new TypeError('quantity must be a positive integer');
  if (strategyCapital !== null && (!Number.isFinite(strategyCapital) || strategyCapital <= 0)) throw new TypeError('strategyCapital must be positive');
  const QTY = quantity;
  let signalId = null;
  let state = 'IDLE';
  let breakout = null;
  let contract = null;
  let quote = null;
  let cap = null;
  let orderId = null;
  let orderStatus = null;
  let submittedAt = null;
  let deadline = null;
  let filled = 0;
  let clientSeq = 0;
  let action = null;
  let pausedReason = null;
  let spreadCap = null;
  let clientOrderId = null;
  let knownOrderIds = new Set();
  let seenExecutions = new Set();
  let terminalObserved = false;
  let cancelDue = false;
  let pendingMutation = null;
  let mutationGeneration = 0;

  const snapshot = () => ({
    orderId,
    status: orderStatus ?? state,
    remainingQty: Math.max(0, QTY - filled),
    active: ['SELECTING', 'SUBMITTING', 'WORKING', 'REPLACING'].includes(state) || Boolean(action) || Boolean(pendingMutation),
    ...(pausedReason ? { reason: pausedReason } : {}),
  });
  const emit = () => {
    return onState?.(snapshot());
  };

  const pause = (reason) => {
    state = 'PAUSED';
    pausedReason = reason;
    emit();
  };

  const priceTicks = (x) => Math.round(Number(x) * 100 + 1e-8);
  const validQuote = (q, maxSpread) => (
    q && Number.isFinite(q.bid) && Number.isFinite(q.ask) &&
    q.bid >= 0 && q.ask >= q.bid && priceTicks(q.ask) - priceTicks(q.bid) <= priceTicks(maxSpread)
  );

  const clearPendingMutation = (pending) => {
    if (pendingMutation !== pending) return false;
    pendingMutation = null;
    mutationGeneration++;
    action = null;
    return true;
  };

  const matchingOrder = (order, { id, clientId = null, side = 'buy' } = {}) => Boolean(order &&
    typeof order.id === 'string' && order.id && order.id === id &&
    order.symbol === contract?.symbol && order.side === side &&
    (clientId === null || order.client_order_id === clientId) &&
    (Number(order.qty) === QTY || Number(order.qty) === Math.max(0, QTY - filled)));

  const applyOrderSnapshot = (order) => {
    if (order.filled_qty === null || order.filled_qty === undefined || order.filled_qty === '') return false;
    const brokerFilled = Number(order.filled_qty);
    if (!Number.isFinite(brokerFilled) || brokerFilled !== filled) return false;
    const status = String(order.status ?? '').toLowerCase();
    const open = ['new', 'accepted', 'pending_new', 'partially_filled'];
    const terminal = ['filled', 'canceled', 'cancelled', 'rejected', 'expired', 'done'];
    if (!open.includes(status) && !terminal.includes(status)) return false;
    if (status === 'filled' && filled !== QTY) return false;
    orderId = order.id;
    knownOrderIds.add(order.id);
    orderStatus = order.status;
    terminalObserved = terminal.includes(status);
    state = filled >= QTY ? 'FILLED' : terminalObserved ? 'DONE' : 'WORKING';
    return true;
  };

  const recoverMutation = async (pending = pendingMutation) => {
    if (!pending || pendingMutation !== pending || pending.reading || nowMono() < pending.nextReadAt) return;
    pending.reading = true;
    pending.nextReadAt = nowMono() + RECOVERY_READ_MS;
    try {
      let order;
      if (pending.kind === 'submit') {
        order = await broker.getOrderByClientOrderId(clientOrderId);
        if (!matchingOrder(order, { id: order?.id, clientId: clientOrderId })) return;
      } else {
        order = await broker.getOrder(pending.orderId);
        if (!matchingOrder(order, { id: pending.orderId, clientId: null })) return;
        if (pending.kind === 'replace') {
          if (!order.replaced_by) return;
          const successor = await broker.getOrder(order.replaced_by);
          if (!successor || successor.id !== order.replaced_by || successor.replaces !== order.id ||
              successor.symbol !== contract?.symbol || successor.side !== 'buy' || Number(successor.qty) !== QTY) return;
          order = successor;
        } else if (!['filled', 'canceled', 'cancelled', 'rejected', 'expired', 'done'].includes(String(order.status ?? '').toLowerCase())) return;
      }
      if (pendingMutation !== pending || mutationGeneration !== pending.generation) return;
      const status = String(order.status ?? '').toLowerCase();
      if (pending.kind === 'replace' && filled >= QTY && ['new', 'accepted', 'pending_new', 'partially_filled'].includes(status) &&
          (order.filled_qty === null || order.filled_qty === undefined || order.filled_qty === '' || Number(order.filled_qty) !== filled)) {
        pending.childOrderId = order.id;
        orderId = order.id; knownOrderIds.add(order.id); orderStatus = order.status; state = 'FILLED';
        if (!pending.childCancelRequested) {
          pending.childCancelRequested = true;
          void Promise.resolve().then(() => broker.cancelOrder(order.id)).catch(() => {});
        }
        emit();
        return;
      }
      if (!applyOrderSnapshot(order)) return;
      if (pending.quote && pending.kind === 'replace') quote = pending.quote;
      if (!clearPendingMutation(pending)) return;
      if (state === 'FILLED' && !terminalObserved) void cancel();
      else if (state === 'WORKING' && cancelDue) void cancel();
      emit();
    } catch {
      // A failed, missing, or incomplete read leaves the mutation unresolved.
    } finally {
      pending.reading = false;
      if (pendingMutation === pending) pending.nextReadAt = Math.max(pending.nextReadAt, nowMono() + RECOVERY_READ_MS);
    }
  };

  const holdForRecovery = (kind, orderIdValue = null, q = null, status = 'UNKNOWN_OUTCOME') => {
    const pending = { kind, orderId: orderIdValue, quote: q, generation: mutationGeneration, reading: false, nextReadAt: nowMono() };
    pendingMutation = pending;
    orderStatus = status;
    action = kind === 'cancel' ? 'CANCEL' : kind === 'replace' ? 'REPLACE' : 'SUBMIT';
    void recoverMutation(pending);
  };


  const choose = async (event, contracts) => {
    const rows = contracts
      .filter((x) => x && Number.isFinite(x.strike) && typeof x.symbol === 'string')
      .sort((a, b) => a.strike - b.strike);
    if (!rows.length) return { reason: 'NO_CONTRACTS' };
    const distances = rows.map((x) => Math.abs(x.strike - event.spyPrice));
    const nearest = Math.min(...distances);
    const tied = rows.filter((x, i) => distances[i] === nearest);
    const atm = tied.length === 1
      ? tied[0]
      : tied.reduce((chosen, row) => event.direction === 'CALL'
        ? (row.strike > chosen.strike ? row : chosen)
        : (row.strike < chosen.strike ? row : chosen));
    const atmQuote = await getQuote(atm.symbol);
    const atmEligible = validQuote(atmQuote, 0.02);
    if (atmEligible) return { row: atm, quote: atmQuote, spreadCap: 0.02 };

    const otm = rows
      .filter((x) => x.symbol !== atm.symbol && (event.direction === 'CALL' ? x.strike > atm.strike : x.strike < atm.strike));
    otm.sort((a, b) => event.direction === 'CALL' ? a.strike - b.strike : b.strike - a.strike);
    if (!otm.length) return { reason: 'NO_OTM_FALLBACK' };
    const q = await getQuote(otm[0].symbol);
    const otmEligible = validQuote(q, 0.05);
    return otmEligible
      ? { row: otm[0], quote: q, spreadCap: 0.05 }
      : { reason: 'NO_ELIGIBLE_QUOTE' };
  };

  const limitFor = (q) => q.ask <= cap + 1e-9 ? q.ask : null;
  const notifyFill = (update) => {
    const n = Math.max(0, Math.floor(update.fillQty || 0));
    const validTimestamp = Number.isFinite(update.timestamp) || (typeof update.timestamp === 'string' && Number.isFinite(Date.parse(update.timestamp)));
    if (!n || !update.executionId || !Number.isFinite(update.fillPrice) || update.fillPrice < 0 || !validTimestamp) return;
    if (filled === 0) deadline = nowMono() + REMAINING_MS;
    const first = filled;
    filled = Math.min(QTY, filled + n);
    for (let i = 0; i < filled - first; i += 1) {
      const tradeId = `${update.executionId}:${first + i + 1}`;
      onFill?.({
        executionId: update.executionId,
        tradeId,
        signalId,
        tradeSetId: clientOrderId,
        entrySetId: clientOrderId,
        actionSource: 'V5_AUTO',
        symbol: contract.symbol,
        entryPrice: update.fillPrice,
        contractSize: contract.contractSize ?? null,
        contractSizeSource: contract.contractSize ? 'alpaca_contract_metadata' : null,
        timestamp: update.timestamp,
      });
    }
    if (filled >= QTY) state = 'FILLED';
    emit();
  };

  const submit = async () => {
    if (!canSubmit()) return abandon('ENTRY_CUTOFF');
    const limitPrice = limitFor(quote);
    if (limitPrice === null) return abandon('ASK_ABOVE_FROZEN_CAP');
    action = 'SUBMIT';
    state = 'SUBMITTING';
    submittedAt = nowMono();
    deadline = submittedAt + NO_FILL_MS;
    clientOrderId = `v5-buy-${randomUUID()}`;
    const submittedClientOrderId = clientOrderId;
    const generation = ++mutationGeneration;
    emit();
    try {
      const result = await broker.submitOrder({ symbol: contract.symbol, qty: QTY, side: 'buy', limitPrice, clientOrderId });
      if (clientOrderId !== submittedClientOrderId || mutationGeneration !== generation) return;
      action = null;
      orderId = result.id;
      knownOrderIds.add(orderId);
      orderStatus = result.status;
      state = filled >= QTY ? 'FILLED' : terminalObserved ? 'DONE' : 'WORKING';
      emit();
      if (state === 'WORKING' && deadline !== null && nowMono() >= deadline) { cancelDue = true; void cancel(); }
    } catch (error) {
      if (clientOrderId !== submittedClientOrderId || mutationGeneration !== generation) return;
      if (orderId && knownOrderIds.has(orderId)) {
        action = null;
        state = filled >= QTY ? 'FILLED' : terminalObserved ? 'DONE' : 'WORKING';
      } else if (!ambiguousMutationError(error)) {
        action = null;
        orderStatus = 'rejected';
        state = 'DONE';
      } else {
        holdForRecovery('submit');
      }
      emit();
      if (state === 'WORKING' && deadline !== null && nowMono() >= deadline) { cancelDue = true; void cancel(); }
    }
  };

  const replace = async (q) => {
    if (!orderId || action || state !== 'WORKING') return;
    const next = limitFor(q);
    if (next === null || (quote && Math.abs(next - limitFor(quote)) < 1e-9)) return;
    action = 'REPLACE';
    state = 'REPLACING';
    emit();
    const oldOrderId = orderId;
    const generation = ++mutationGeneration;
    try {
      const result = await broker.replaceOrder(oldOrderId, { qty: Math.max(0, QTY - filled), limitPrice: next });
      if (mutationGeneration !== generation) return;
      if (!result?.id) { holdForRecovery('replace', oldOrderId, q); emit(); return; }
      if (orderId !== oldOrderId || state === 'FILLED' || state === 'DONE') {
        if (result?.id) {
          knownOrderIds.add(oldOrderId); knownOrderIds.add(result.id); orderId = result.id;
          orderStatus = result.status; terminalObserved = ['filled', 'canceled', 'cancelled', 'rejected', 'expired', 'done'].includes(String(result.status ?? '').toLowerCase());
          state = filled >= QTY ? 'FILLED' : terminalObserved ? 'DONE' : 'WORKING';
          action = null;
          if (!terminalObserved) void cancel();
          emit();
        }
        return;
      }
      knownOrderIds.add(oldOrderId);
      orderId = result.id;
      knownOrderIds.add(orderId);
      orderStatus = result.status;
      quote = q;
      action = null;
      state = 'WORKING';
      emit();
      if (cancelDue) void cancel();
    } catch (error) {
      if (mutationGeneration !== generation) return;
      if (ambiguousMutationError(error)) holdForRecovery('replace', oldOrderId, q);
      else { action = null; state = filled >= QTY ? 'FILLED' : 'WORKING'; }
      emit();
      if (cancelDue) void cancel();
    }
  };

  const cancel = async () => {
    if (!orderId || action || !['WORKING', 'FILLED'].includes(state)) return;
    action = 'CANCEL';
    const targetOrderId = orderId;
    const generation = ++mutationGeneration;
    try {
      await broker.cancelOrder(targetOrderId);
      if (mutationGeneration !== generation) return;
      action = null;
      orderStatus = 'CANCEL_REQUESTED';
      holdForRecovery('cancel', targetOrderId, null, 'CANCEL_REQUESTED');
      emit();
    } catch {
      if (mutationGeneration !== generation) return;
      holdForRecovery('cancel', targetOrderId);
      emit();
    }
  };

  const abandon = (reason) => {
    pausedReason = reason;
    state = 'IDLE';
    emit();
  };

  return {
    async onBreakout(event) {
      if (state !== 'IDLE') return;
      if (!event || !['CALL', 'PUT'].includes(event.direction) || !Number.isFinite(event.spyPrice)) return pause('INVALID_BREAKOUT');
      signalId = `signal-${randomUUID()}`;
      pausedReason = null;
      state = 'SELECTING';
      emit();
      breakout = event;
      let picked;
      try {
        picked = await choose(event, await getContracts(event.direction, event.timestamp));
      } catch {
        return abandon('SELECTION_FAILED');
      }
      if (!picked.row) return abandon(picked.reason);
      contract = picked.row;
      quote = picked.quote;
      spreadCap = picked.spreadCap;
      cap = (quote.bid + quote.ask) / 2 + 0.03;
      // Reserve the full frozen reprice ceiling, not only the initial ask.
      // The fixed SPY strategy uses standard 100-share option contracts.
      if (strategyCapital !== null && cap * QTY * (contract.contractSize ?? 100) > strategyCapital + 1e-9) return abandon('ENTRY_CAPITAL_LIMIT');
      await submit();
    },
    onOrderUpdate(update) {
      if (!update) return;
      const streamMatches = Boolean(clientOrderId && update.clientOrderId === clientOrderId) || knownOrderIds.has(update.orderId) ||
        knownOrderIds.has(update.replaces) || knownOrderIds.has(update.replacedBy) ||
        pendingMutation?.kind === 'replace' && update.replaces === pendingMutation.orderId;
      if (!streamMatches) return;
      const pending = pendingMutation;
      const replacementStreamAdopted = action === 'REPLACE' && Boolean(update.orderId) &&
        (update.replaces === orderId || update.orderId === orderId && Boolean(update.replacedBy));
      if (!orderId && clientOrderId && update.clientOrderId === clientOrderId && update.orderId) {
        orderId = update.orderId; knownOrderIds.add(orderId);
      }
      if (pending?.kind === 'submit' && update.clientOrderId === clientOrderId && update.orderId) {
        orderId = update.orderId; knownOrderIds.add(orderId);
      }
      if (update.replaces && knownOrderIds.has(update.replaces) && update.orderId) {
        knownOrderIds.add(update.orderId); orderId = update.orderId;
      }
      if (update.replacedBy && knownOrderIds.has(update.orderId)) {
        knownOrderIds.add(update.replacedBy); orderId = update.replacedBy;
      }
      if (update.executionId && seenExecutions.has(update.executionId)) return;
      if (update.executionId) seenExecutions.add(update.executionId);
      if (update.event) {
        orderStatus = update.event;
        const eventStatus = String(update.event).toLowerCase();
        const terminal = ['canceled', 'cancelled', 'done', 'expired', 'rejected'].includes(eventStatus);
        if (terminal && (!orderId || update.orderId === orderId)) { terminalObserved = true; state = 'DONE'; }
        if (action === 'CANCEL' && !pendingMutation && update.orderId === orderId && (terminal || String(update.event).toLowerCase() === 'fill')) {
          mutationGeneration++; action = null;
        }
        if (action === 'REPLACE' && update.orderId === orderId && ['order_replace_rejected', 'replace_rejected'].includes(String(update.event).toLowerCase())) {
          mutationGeneration++; action = null; state = filled >= QTY ? 'FILLED' : terminalObserved ? 'DONE' : 'WORKING';
        }
      }
      notifyFill(update);
      if (pendingMutation && pendingMutation === pending) {
        const eventStatus = String(update.event ?? '').toLowerCase();
        const sameOrder = update.orderId === pending.orderId || update.replaces === pending.orderId ||
          pending.kind === 'replace' && update.orderId === pending.childOrderId ||
          pending.kind === 'submit' && Boolean(clientOrderId) && update.clientOrderId === clientOrderId;
        const successorByReplaces = pending.kind === 'replace' && update.replaces === pending.orderId && Boolean(update.orderId);
        const successorByReplacedBy = pending.kind === 'replace' && update.orderId === pending.orderId && Boolean(update.replacedBy);
        const successorProven = successorByReplaces || successorByReplacedBy;
        const replaceRejected = pending.kind === 'replace' && update.orderId === pending.orderId &&
          ['order_replace_rejected', 'replace_rejected'].includes(eventStatus);
        const replacementChildTerminal = pending.kind === 'replace' && update.orderId === pending.childOrderId &&
          ['fill', 'canceled', 'cancelled', 'done', 'expired', 'rejected'].includes(eventStatus);
        const cancelTerminal = pending.kind === 'cancel' && sameOrder &&
          ['fill', 'canceled', 'cancelled', 'done', 'expired', 'rejected'].includes(eventStatus);
        if (pending.kind === 'submit' && sameOrder && update.orderId || successorProven || replaceRejected || replacementChildTerminal || cancelTerminal) {
          if (successorByReplaces) { orderId = update.orderId; knownOrderIds.add(update.orderId); pending.childOrderId = update.orderId; }
          if (successorByReplacedBy) { orderId = update.replacedBy; knownOrderIds.add(update.replacedBy); pending.childOrderId = update.replacedBy; }
          if (pending.kind === 'submit' || pending.kind === 'cancel') {
            if (update.orderId) orderId = update.orderId;
            if (eventStatus === 'fill' && filled < QTY) {
              // A fill status without its execution event cannot release the admission block.
            } else if (clearPendingMutation(pending) && pending.kind === 'submit') state = filled >= QTY ? 'FILLED' : terminalObserved ? 'DONE' : 'WORKING';
          } else if ((successorProven || replaceRejected || replacementChildTerminal) && clearPendingMutation(pending)) state = filled >= QTY ? 'FILLED' : terminalObserved ? 'DONE' : 'WORKING';
        }
      }
      if (String(update.event ?? '').toLowerCase() === 'fill' && filled >= QTY && update.orderId === orderId) terminalObserved = true;
      if (replacementStreamAdopted && action === 'REPLACE') {
        mutationGeneration++; action = null; state = filled >= QTY ? 'FILLED' : 'WORKING';
      }
      if (replacementStreamAdopted && state === 'FILLED' && !terminalObserved && !pending?.childCancelRequested) void cancel();
      emit();
    },
    tick() {
      if (pendingMutation) { void recoverMutation(pendingMutation); return; }
      if (!['WORKING', 'REPLACING'].includes(state) || !orderId) return;
      if (deadline !== null && nowMono() >= deadline) {
        cancelDue = true;
        if (action === 'REPLACE') return;
        void cancel();
      } else if (action) return;
      else {
        const nextQuote = getQuote(contract.symbol);
        if (nextQuote?.then) return void nextQuote.then((q) => { if (q?.ask !== quote?.ask) void replace(q); });
        if (nextQuote && quote && nextQuote.ask !== quote.ask) {
          void replace(nextQuote);
        }
      }
    },
    getState() {
      return { ...snapshot(), state, breakout, contract, quote, cap, orderStatus, filled, deadline, pausedReason, clientOrderId };
    },
    nextDeadline() { return deadline; },
    ready() {
      if (!pendingMutation && !action && ['DONE', 'FILLED', 'PAUSED'].includes(state)) {
        state = 'IDLE'; pausedReason = null; orderId = null; orderStatus = null; filled = 0; deadline = null;
        action = null; clientOrderId = null; knownOrderIds = new Set(); seenExecutions = new Set(); cancelDue = false;
        breakout = null; contract = null; quote = null; cap = null; spreadCap = null; terminalObserved = false;
        emit();
      }
    },
  };
}
