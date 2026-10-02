import { randomUUID } from 'node:crypto';

const NO_FILL_MS = 2_000;
const REMAINING_MS = 5_000;

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

  const snapshot = () => ({
    orderId,
    status: orderStatus ?? state,
    remainingQty: Math.max(0, QTY - filled),
    active: ['SELECTING', 'SUBMITTING', 'WORKING', 'REPLACING'].includes(state) || action === 'CANCEL',
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
    emit();
    try {
      const result = await broker.submitOrder({ symbol: contract.symbol, qty: QTY, side: 'buy', limitPrice, clientOrderId });
      if (clientOrderId !== submittedClientOrderId) return;
      action = null;
      orderId = result.id;
      knownOrderIds.add(orderId);
      orderStatus = result.status;
      state = terminalObserved ? 'DONE' : (filled >= QTY ? 'FILLED' : 'WORKING');
      emit();
      if (state === 'WORKING' && deadline !== null && nowMono() >= deadline) { cancelDue = true; void cancel(); }
    } catch (error) {
      if (clientOrderId !== submittedClientOrderId) return;
      action = null;
      if (orderId) {
        state = terminalObserved ? 'DONE' : (filled >= QTY ? 'FILLED' : 'WORKING');
      } else if (error?.httpStatus >= 400 && error.httpStatus < 500 && ![408, 409, 429].includes(error.httpStatus) && !/duplicate|already.*(?:exist|use)|must be unique/i.test(error.message ?? '')) {
        orderStatus = 'rejected';
        state = 'DONE';
      } else {
        orderStatus = 'UNKNOWN_OUTCOME';
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
    try {
      const result = await broker.replaceOrder(oldOrderId, { qty: Math.max(0, QTY - filled), limitPrice: next });
      if (orderId !== oldOrderId || state === 'FILLED' || state === 'DONE') return;
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
      action = null;
      state = filled >= QTY ? 'FILLED' : 'WORKING';
      emit();
      if (cancelDue) void cancel();
    }
  };

  const cancel = async () => {
    if (!orderId || action || state !== 'WORKING' || filled >= QTY) return;
    action = 'CANCEL';
    try {
      await broker.cancelOrder(orderId);
      action = null;
      orderStatus = 'CANCEL_REQUESTED';
      emit();
    } catch (error) {
      action = null;
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
      if (!update || (!orderId && update.clientOrderId !== clientOrderId)) return;
      if (update.clientOrderId !== clientOrderId && !knownOrderIds.has(update.orderId) && !knownOrderIds.has(update.replacedBy)) return;
      if (!orderId && clientOrderId && update.orderId) { orderId = update.orderId; knownOrderIds.add(orderId); }
      if (update.executionId && seenExecutions.has(update.executionId)) return;
      if (update.executionId) seenExecutions.add(update.executionId);
      if (update.event) {
        orderStatus = update.event;
        const terminal = ['canceled', 'cancelled', 'done', 'expired', 'rejected'].includes(String(update.event).toLowerCase());
        if (terminal && (!orderId || update.orderId === orderId)) { terminalObserved = true; state = 'DONE'; }
      }
      notifyFill(update);
      emit();
    },
    tick() {
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
      if (['DONE', 'FILLED', 'PAUSED'].includes(state)) {
        state = 'IDLE'; pausedReason = null; orderId = null; orderStatus = null; filled = 0; deadline = null;
        action = null; clientOrderId = null; knownOrderIds = new Set(); seenExecutions = new Set(); cancelDue = false;
        breakout = null; contract = null; quote = null; cap = null; spreadCap = null; terminalObserved = false;
        emit();
      }
    },
  };
}
