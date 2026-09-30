import { observe } from './telemetry/trace.mjs';
import { randomUUID } from 'node:crypto';

const QTY = 3;
const NO_FILL_MS = 2_000;
const REMAINING_MS = 5_000;

export function createEntry({ broker, getContracts, getQuote, onFill, onState, nowMono, telemetry, canSubmit = () => true }) {
  const trace = (event, fields = {}) => observe(telemetry, event, { actionSource: 'V5_AUTO', ...(signalId ? { signalId } : {}), ...(clientOrderId ? { tradeSetId: clientOrderId, entrySetId: clientOrderId, clientOrderId } : {}), ...fields });
  let signalId = null;
  let state = 'IDLE';
  let breakout = null;
  let contract = null;
  let quote = null;
  let selection = null;
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
  let tracePreviousEntryState = 'IDLE';
  const emit = () => {
    trace('entry_state', { signalId, entrySetId: clientOrderId, orderId, priorState: tracePreviousEntryState, state, orderStatus, remainingQty: Math.max(0, QTY - filled), action, reason: pausedReason });
    tracePreviousEntryState = state;
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
  const quoteRejection = (q, maxSpread) => !q ? 'missing_quote'
    : !Number.isFinite(q.bid) || !Number.isFinite(q.ask) ? 'invalid_bid_ask'
      : q.bid < 0 ? 'negative_bid'
        : q.ask < q.bid ? 'crossed_market'
          : priceTicks(q.ask) - priceTicks(q.bid) > priceTicks(maxSpread) ? 'spread_over_cap' : null;

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
    let atmQuote;
    try { atmQuote = await getQuote(atm.symbol); }
    catch (error) {
      trace('contract_candidate', { role: 'ATM', symbol: atm.symbol, strike: atm.strike, spreadCap: 0.02, eligible: false, rejectionReason: 'quote_request_failed', errorName: error?.name, sourceTimestamp: null, receivedAt: Date.now() });
      throw error;
    }
    const atmReceivedAt = Date.now();
    const atmReceivedMono = performance.now();
    const atmEligible = validQuote(atmQuote, 0.02);
    const atmMid = atmQuote && Number.isFinite(atmQuote.bid) && Number.isFinite(atmQuote.ask) ? (atmQuote.bid + atmQuote.ask) / 2 : null;
    trace('contract_candidate', { role: 'ATM', symbol: atm.symbol, strike: atm.strike, bid: atmQuote?.bid, ask: atmQuote?.ask, mid: atmMid, spread: atmQuote && Number.isFinite(atmQuote.bid) && Number.isFinite(atmQuote.ask) ? atmQuote.ask - atmQuote.bid : null, sourceTimestamp: atmQuote?.timestamp, quoteTimestamp: atmQuote?.timestamp, receivedAt: atmReceivedAt, receivedMonoMs: atmReceivedMono, spreadCap: 0.02, eligible: Boolean(atmEligible), rejectionReason: quoteRejection(atmQuote, 0.02) });
    if (atmEligible) return { row: atm, quote: atmQuote, spreadCap: 0.02, role: 'ATM', rationale: 'nearest_strike_quote_within_2c_spread', receivedAt: atmReceivedAt, receivedMonoMs: atmReceivedMono };

    const otm = rows
      .filter((x) => x.symbol !== atm.symbol && (event.direction === 'CALL' ? x.strike > atm.strike : x.strike < atm.strike));
    otm.sort((a, b) => event.direction === 'CALL' ? a.strike - b.strike : b.strike - a.strike);
    if (!otm.length) return { reason: 'NO_OTM_FALLBACK' };
    let q;
    try { q = await getQuote(otm[0].symbol); }
    catch (error) {
      trace('contract_candidate', { role: 'OTM_FALLBACK', symbol: otm[0].symbol, strike: otm[0].strike, spreadCap: 0.05, eligible: false, rejectionReason: 'quote_request_failed', errorName: error?.name, sourceTimestamp: null, receivedAt: Date.now() });
      throw error;
    }
    const receivedAt = Date.now();
    const receivedMonoMs = performance.now();
    const otmEligible = validQuote(q, 0.05);
    const mid = q && Number.isFinite(q.bid) && Number.isFinite(q.ask) ? (q.bid + q.ask) / 2 : null;
    trace('contract_candidate', { role: 'OTM_FALLBACK', symbol: otm[0].symbol, strike: otm[0].strike, bid: q?.bid, ask: q?.ask, mid, spread: q && Number.isFinite(q.bid) && Number.isFinite(q.ask) ? q.ask - q.bid : null, sourceTimestamp: q?.timestamp, quoteTimestamp: q?.timestamp, receivedAt, receivedMonoMs, spreadCap: 0.05, eligible: Boolean(otmEligible), rejectionReason: quoteRejection(q, 0.05) });
    return otmEligible
      ? { row: otm[0], quote: q, spreadCap: 0.05, role: 'OTM_FALLBACK', rationale: 'nearest_directional_otm_after_atm_rejection', receivedAt, receivedMonoMs }
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
      trace('entry_fill_link', { direction: breakout?.direction, orderId: update.orderId, clientOrderId, executionId: update.executionId, tradeId, symbol: contract.symbol, entryPrice: update.fillPrice, contractSize: contract.contractSize ?? null, contractSizeSource: contract.contractSize ? 'alpaca_contract_metadata' : null, brokerTimestamp: update.timestamp });
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
    trace('entry_set', { clientOrderId, direction: breakout?.direction, signalTimestamp: breakout?.timestamp, signalSourceTradeId: breakout?.sourceTradeId, signalReceivedAt: breakout?.receivedAt, spyPrice: breakout?.spyPrice, priorHigh: breakout?.priorHigh, priorLow: breakout?.priorLow, symbol: contract.symbol, limitPrice, quantity: QTY, maxBuyQty: QTY, cap, bid: quote.bid, ask: quote.ask, mid: (quote.bid + quote.ask) / 2, quoteTimestamp: quote.timestamp, selectionRole: selection?.role, selectionRationale: selection?.rationale, selectionQuoteReceivedAt: selection?.receivedAt, selectionQuoteReceivedMonoMs: selection?.receivedMonoMs });
    emit();
    try {
      trace('buy_submit', { signalId, entrySetId: clientOrderId, symbol: contract.symbol, quantity: QTY, limitPrice });
      const result = await broker.submitOrder({ symbol: contract.symbol, qty: QTY, side: 'buy', limitPrice, clientOrderId });
      if (clientOrderId !== submittedClientOrderId) return;
      trace('buy_response', { signalId, entrySetId: clientOrderId, orderId: result?.id, status: result?.status, operation: 'submit' });
      action = null;
      orderId = result.id;
      knownOrderIds.add(orderId);
      orderStatus = result.status;
      state = terminalObserved ? 'DONE' : (filled >= QTY ? 'FILLED' : 'WORKING');
      emit();
      if (state === 'WORKING' && deadline !== null && nowMono() >= deadline) { cancelDue = true; void cancel(); }
    } catch (error) {
      if (clientOrderId !== submittedClientOrderId) return;
      trace('buy_api_error', { signalId, entrySetId: clientOrderId, orderId, operation: action, errorName: error?.name, httpStatus: error?.httpStatus, code: error?.code, message: error?.message });
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
      trace('buy_reprice', { signalId, entrySetId: clientOrderId, orderId: oldOrderId, quantity: Math.max(0, QTY - filled), previousPrice: quote ? limitFor(quote) : null, limitPrice: next, bid: q.bid, ask: q.ask, quoteTimestamp: q.timestamp });
      const result = await broker.replaceOrder(oldOrderId, { qty: Math.max(0, QTY - filled), limitPrice: next });
      trace('buy_response', { signalId, entrySetId: clientOrderId, orderId: result?.id, status: result?.status, operation: 'replace' });
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
      trace('buy_api_error', { signalId, entrySetId: clientOrderId, orderId, operation: action, errorName: error?.name, httpStatus: error?.httpStatus });
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
      trace('buy_cancel_request', { signalId, entrySetId: clientOrderId, orderId });
      await broker.cancelOrder(orderId);
      trace('buy_cancel_response', { signalId, entrySetId: clientOrderId, orderId });
      action = null;
      orderStatus = 'CANCEL_REQUESTED';
      emit();
    } catch (error) {
      trace('buy_api_error', { signalId, entrySetId: clientOrderId, orderId, operation: action, errorName: error?.name, httpStatus: error?.httpStatus });
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
      trace('signal_accepted_for_selection', { signalKey: `${event.direction}:${event.timestamp}:${event.spyPrice}`, direction: event.direction, signalTimestamp: event.timestamp, sourceTradeId: event.sourceTradeId, receivedAt: event.receivedAt, spyPrice: event.spyPrice, priorHigh: event.priorHigh, priorLow: event.priorLow, priorCount: event.priorCount });
      state = 'SELECTING';
      emit();
      breakout = event;
      const picked = await choose(event, await getContracts(event.direction, event.timestamp));
      if (!picked.row) return abandon(picked.reason);
      selection = picked;
      contract = picked.row;
      quote = picked.quote;
      spreadCap = picked.spreadCap;
      cap = (quote.bid + quote.ask) / 2 + 0.03;
    trace('entry_construction', { signalId, direction: event.direction, symbol: contract.symbol, strike: contract.strike, contractSize: contract.contractSize ?? null, contractSizeSource: contract.contractSize ? 'alpaca_contract_metadata' : null, bid: quote.bid, ask: quote.ask, quoteTimestamp: quote.timestamp, spread: quote.ask - quote.bid, spreadCap, midpoint: (quote.bid + quote.ask) / 2, frozenCap: cap });
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
        breakout = null; contract = null; quote = null; selection = null; cap = null; spreadCap = null; terminalObserved = false;
        emit();
      }
    },
  };
}
