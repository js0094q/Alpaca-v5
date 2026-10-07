import { createSignal } from './signal.mjs';
import { createEntry } from './entry.mjs';
import { createPositions } from './positions.mjs';
import { createContinuity, reconcileContinuity } from './continuity.mjs';
import { createSipProcessor } from './sip.mjs';

export const FIVE_SECONDS = 5_000;
const DAILY_MAX_LOSS_RATE = 0.10;
const OWNERSHIP_CHECK_MS = 5_000;
const isSpyOption = (symbol) => /^SPY\d{6}[CP]\d{8}$/.test(String(symbol));
const dateInET = (value) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const localMinutes = (value) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(value));
  return Number(parts.find(({ type }) => type === 'hour')?.value) % 24 * 60 + Number(parts.find(({ type }) => type === 'minute')?.value);
};
export function createRuntime({ broker, getContracts, getQuote, calendar, now = () => Date.now(), nowMono = () => performance.now(), ledger = () => {}, telemetry = () => {}, continuity = createContinuity(), dailyLossGuard = false, strategyCapital = null, entryQuantity = 1, liquidateAt = null, entryCutoffMinuteET = 11 * 60 + 30, stopAtMs = null }) {
  if (!broker || !getContracts || !getQuote || !calendar) throw new TypeError('broker, contract, quote, and calendar inputs are required');
  if (!Number.isInteger(entryCutoffMinuteET) || entryCutoffMinuteET < 0 || entryCutoffMinuteET >= 24 * 60) throw new RangeError('entryCutoffMinuteET must be an integer minute of day');
  const buyCutoffMinuteET = Math.min(entryCutoffMinuteET, 11 * 60 + 30);
  if (stopAtMs !== null && !Number.isFinite(stopAtMs)) throw new TypeError('stopAtMs must be a finite timestamp');
  if (liquidateAt !== null && !Number.isFinite(liquidateAt)) throw new TypeError('liquidateAt must be a finite timestamp');
  let state = 'STARTING';
  let sessionDate = null;
  let ledgerDate = null;
  let finalizedDate = null;
  let cooldownUntil = 0;
  let externalSellSymbols = new Set();
  let setAccounting = new Map();
  let dailyLoss = null;
  let dailyLossStateUnavailable = false;
  let filledEntryStateUnavailable = false;
  let filledEntryDate = null;
  let startupEquity = null;
  let startupEquityDate = null;
  let dailyLossBaselineFetch;
  let entryState = { active: false };
  let started = false;
  let recovering = false;
  let hydrating = false;
  let timer;
  let deadlineTimer;
  let ownershipScan;
  let nextOwnershipScanAt = 0;
  let nextStatusAt = -Infinity;
  const sipObservation = { messages: 0, rejected: 0, lastMessageAt: null, lastRejectedReason: null };
  const cancelingBuys = new Set();
  const executionIssues = [];
  const safeLedger = (event, data = {}) => {
    try {
      const result = ledger({ timestamp: new Date(now()).toISOString(), event, ...(ledgerDate ? { date: ledgerDate, ledgerId: `v5-day-${ledgerDate}` } : {}), ...data });
      Promise.resolve(result).catch(() => {});
    } catch {}
  };
  const trades = () => positions.getTrades();
  const hasLongOwnership = () => trades().some((trade) => (trade.remainingQty ?? 0) > 0);
  const hasOwnership = () => hasLongOwnership() || positions.hasPendingExecution() || executionIssues.length > 0;
  const ownershipSignature = (owned) => JSON.stringify(owned.map((trade) => [
    trade.tradeId, trade.symbol, trade.remainingQty, trade.profitFloor, trade.sellLatched,
    trade.logicalSellId, trade.orderId, trade.inFlight,
  ]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  const setState = (next, data) => { if (executionIssues.length) next = 'BLOCKED_EXECUTION'; if (state !== next) { state = next; safeLedger(next, data); } };
  const entryActive = () => Boolean(entryState.active);
  const cents = (value) => Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) : null;
  const persistContinuity = () => continuity.save(trades(), { pause: null, sets: [...setAccounting.values()], filledEntryDate, ...(dailyLossGuard && dailyLoss ? { dailyLoss } : {}) });
  const canEnterDailyLoss = () => !filledEntryStateUnavailable && filledEntryDate !== sessionDate && (!dailyLossGuard || Boolean(!dailyLossStateUnavailable && dailyLoss && dailyLoss.date === sessionDate && !dailyLoss.tripped));
  const establishDailyLoss = (date, equity, { persist = true } = {}) => {
    // Retain the continuity field name; PAPER uses configured strategy capital.
    const dayStartEquity = Number(strategyCapital ?? equity);
    if (!Number.isFinite(dayStartEquity) || dayStartEquity <= 0) return false;
    dailyLoss = { date, dayStartEquity, cumulativeRealizedGross: 0, peakRealizedGross: 0, tripped: false, completedBuyIds: [] };
    dailyLossStateUnavailable = false;
    if (persist) persistContinuity();
    safeLedger('DAY_START_EQUITY', { date, dayStartEquity, dailyMaxLoss: dayStartEquity * DAILY_MAX_LOSS_RATE });
    return true;
  };
  // Max loss is a fixed share of strategy capital, measured down from the day's
  // realized high-water mark (never below $0), so gains never widen the limit.
  const tripDailyLoss = () => {
    const cumulativeCents = Math.round(dailyLoss.cumulativeRealizedGross * 100);
    const peakCents = Math.max(0, Math.round(dailyLoss.peakRealizedGross * 100), cumulativeCents);
    dailyLoss.peakRealizedGross = peakCents / 100;
    const limitCents = Math.round(Math.round(dailyLoss.dayStartEquity * 100) * DAILY_MAX_LOSS_RATE);
    if (dailyLoss.tripped || peakCents - cumulativeCents < limitCents) return false;
    dailyLoss.tripped = true;
    return true;
  };
  const finishSetIfReady = (record) => {
    if (record && !record.known && !hasOwnership() && !entryActive() && cancelingBuys.size === 0) {
      safeLedger('TRADE_RESULT', { tradeSetId: record.tradeSetId, result: 'unknown' });
      setAccounting.delete(record.tradeSetId);
      persistContinuity();
      return true;
    }
    if (!record || !record.entryTerminal || record.closedAt === null || Math.abs(record.exitQty - record.entryQty) > 1e-6) return false;
    if (record.known) {
      const grossCentQty = Math.round((record.exitCentQty - record.entryCentQty) * 1_000_000);
      if (dailyLossGuard && record.date === dailyLoss?.date && !dailyLoss.completedBuyIds.includes(record.tradeSetId)) {
        dailyLoss.completedBuyIds.push(record.tradeSetId);
        // For the fixed SPY option strategy, a cent of premium per share is
        // one dollar per contract (100-share contract multiplier).
        dailyLoss.cumulativeRealizedGross = Math.round((dailyLoss.cumulativeRealizedGross + grossCentQty / 1_000_000) * 100) / 100;
        if (tripDailyLoss()) safeLedger('DAILY_MAX_LOSS', { date: dailyLoss.date, dayStartEquity: dailyLoss.dayStartEquity, cumulativeRealizedGross: dailyLoss.cumulativeRealizedGross, peakRealizedGross: dailyLoss.peakRealizedGross, threshold: dailyLoss.peakRealizedGross - dailyLoss.dayStartEquity * DAILY_MAX_LOSS_RATE });
      }
      safeLedger('TRADE_RESULT', { tradeSetId: record.tradeSetId, result: grossCentQty < 0 ? 'loss' : grossCentQty === 0 ? 'zero' : 'profit', grossCentQty });
    } else {
      safeLedger('TRADE_RESULT', { tradeSetId: record.tradeSetId, result: 'unknown' });
    }
    setAccounting.delete(record.tradeSetId);
    persistContinuity();
    return true;
  };
  const recordEntryState = () => {
    const current = entry?.getState?.();
    const record = current?.clientOrderId ? setAccounting.get(current.clientOrderId) : null;
    if (!record) return;
    const orderStatus = String(current.orderStatus ?? '').toLowerCase();
    record.entryTerminal = current.state === 'DONE' || current.filled >= entryQuantity || ['canceled', 'cancelled', 'done', 'expired', 'rejected'].includes(orderStatus);
    if (record.entryTerminal) {
      persistContinuity();
      finishSetIfReady(record);
    }
  };
  const finalizeLedger = (date) => {
    if (!date || finalizedDate === date) return;
    finalizedDate = date;
    safeLedger('DAY_FINALIZE', { date, ledgerId: `v5-day-${date}` });
  };
  const beginSession = (session, current) => {
    if (!session?.date || sessionDate === session.date) return;
    if (ledgerDate && ledgerDate !== session.date) finalizeLedger(ledgerDate);
    sessionDate = session.date;
    ledgerDate = session.date;
    finalizedDate = null;
    signal.setSession(session);
    signal.reset(current);
    sip.reset();
    if (dailyLossGuard && dailyLoss?.date !== session.date) {
      dailyLoss = null;
      if (!dailyLossStateUnavailable && startupEquityDate === session.date) establishDailyLoss(session.date, startupEquity);
      else if ((!dailyLossStateUnavailable || startupEquityDate !== session.date) && !dailyLossBaselineFetch) {
        dailyLossBaselineFetch = broker.inspectCurrentState().then((snapshot) => {
          if (sessionDate === session.date && !dailyLoss) establishDailyLoss(session.date, snapshot?.account?.equity);
        }).catch(() => {}).finally(() => { dailyLossBaselineFetch = null; tick(); });
      }
    }
    safeLedger('DAY_START', { date: session.date, ledgerId: `v5-day-${session.date}`, ...(dailyLoss?.date === session.date ? { dayStartEquity: dailyLoss.dayStartEquity, dailyMaxLoss: dailyLoss.dayStartEquity * DAILY_MAX_LOSS_RATE } : {}) });
  };

  const positions = createPositions({ broker, onExit, onTelemetry: telemetry, getDayStartCapital: () => dailyLoss?.dayStartEquity ?? strategyCapital, onExecutionIssue: (issue) => {
    if (issue.resolved) {
      const index = executionIssues.findIndex((prior) => prior.reason === issue.reason && prior.orderId === issue.orderId && prior.tradeId === issue.tradeId);
      if (index >= 0) executionIssues.splice(index, 1);
      safeLedger('EXECUTION_ISSUE_RESOLVED', issue);
      setState(hasLongOwnership() ? 'MANAGING' : 'COOLDOWN');
    } else {
      if (!executionIssues.some((prior) => prior.reason === issue.reason && prior.orderId === issue.orderId && prior.tradeId === issue.tradeId)) executionIssues.push(issue);
      safeLedger('EXECUTION_ISSUE', issue); setState('BLOCKED_EXECUTION', issue);
    }
  }, onState: (s) => { if (!hydrating) continuity.save(positions.getTrades()); if (s?.state) setState(s.state, s); else if (s?.reconciling) setState('RECONCILING', s); }, now, nowMono });
  let entry;
  entry = createEntry({ broker, quantity: entryQuantity, strategyCapital, canSubmit: () => { const current = now(), session = calendar.sessionFor(current); return canEnterDailyLoss() && signal.canEnter(current) && localMinutes(current) < buyCutoffMinuteET && (stopAtMs === null || current < stopAtMs) && session?.status === 'open' && session.date === sessionDate && (!session.cutoff || current < Date.parse(session.cutoff)); }, getContracts, getQuote, now, nowMono, onFill: (fill) => {
    safeLedger('FILL', fill);
    filledEntryDate = sessionDate;
    const priceCents = cents(fill.entryPrice);
    if (fill.tradeSetId && priceCents !== null) {
      let record = setAccounting.get(fill.tradeSetId);
      if (!record) {
        const current = now(), session = calendar.sessionFor(current);
        record = { tradeSetId: fill.tradeSetId, date: session?.date ?? sessionDate, known: true, entryQty: 0, entryCentQty: 0, exitQty: 0, exitCentQty: 0, entryTerminal: false, closedAt: null };
        setAccounting.set(fill.tradeSetId, record);
      }
      record.entryQty += 1;
      record.entryCentQty += priceCents;
    }
    positions.onFill(fill);
    persistContinuity();
  }, onState: (s) => { entryState = s; recordEntryState(); const status = s?.status ?? s?.state; if (['IDLE', 'DONE', 'canceled', 'rejected', 'expired'].includes(status) && !hasOwnership() && cancelingBuys.size === 0) { if (state !== 'COOLDOWN') { entry.ready?.(); setState('FLAT'); } } scheduleDeadline(); } });
  const signal = createSignal({ onBreakout });
  const sip = createSipProcessor({ onTrade: (trade, receivedAt) => signal.onTrade(trade, receivedAt), onCorrection: (change, receivedAt) => signal.onCorrection(change, receivedAt), onCancel: (change, receivedAt) => signal.onCancel(change, receivedAt) });

  async function startup() {
    if (typeof broker.inspectCurrentState !== 'function') throw new Error('broker.inspectCurrentState is required for startup');
    const snapshot = await broker.inspectCurrentState();
    if (!Array.isArray(snapshot?.positions) || !Array.isArray(snapshot?.orders)) throw new Error('Incomplete broker current state');
    for (const order of snapshot.orders ?? []) {
      const id = order.clientOrderId ?? order.client_order_id;
      if (order.side === 'buy' && ['new', 'accepted', 'pending_new', 'partially_filled'].includes(order.status) && String(id).startsWith('v5-buy-')) { cancelingBuys.add(order.id); await broker.cancelOrder(order.id); safeLedger('CANCEL_INTERRUPTED_BUY', { orderId: order.id }); }
    }
    const exposure = (snapshot.positions ?? []).filter((p) => Number(p.qty ?? p.quantity ?? 0) > 0 && isSpyOption(p.symbol));
    const saved = continuity.load();
    filledEntryStateUnavailable = ['corrupt', 'incompatible'].includes(saved.status);
    const currentSession = calendar.sessionFor(now());
    const accountEquity = Number(snapshot.account?.equity);
    startupEquity = Number.isFinite(accountEquity) && accountEquity > 0 ? accountEquity : null;
    startupEquityDate = currentSession?.date ?? null;
    dailyLossStateUnavailable = dailyLossGuard && ['corrupt', 'incompatible'].includes(saved.status);
    dailyLoss = dailyLossGuard && saved.dailyLoss?.date === currentSession?.date ? { ...saved.dailyLoss, completedBuyIds: [...saved.dailyLoss.completedBuyIds] } : null;
    filledEntryDate = saved.filledEntryDate === currentSession?.date || (saved.dailyLoss?.date === currentSession?.date && saved.dailyLoss.completedBuyIds.length > 0) ? currentSession?.date ?? null : null;
    // The day's loss budget stays frozen at its DAY_START capital; a capital
    // change takes effect on the next trading date.
    if (dailyLoss) {
      // Same-day state written before the high-water mark existed cannot prove
      // its peak, so block further BUYs for that date rather than guess one.
      const legacy = dailyLoss.peakRealizedGross === undefined;
      if (legacy) {
        dailyLoss.peakRealizedGross = Math.max(0, dailyLoss.cumulativeRealizedGross);
        if (dailyLoss.completedBuyIds.length) dailyLoss.tripped = true;
      }
      tripDailyLoss();
      if (dailyLoss.tripped) safeLedger('DAILY_LOSS_LIMIT_RESTORED', { date: dailyLoss.date, peakRealizedGross: dailyLoss.peakRealizedGross, cumulativeRealizedGross: dailyLoss.cumulativeRealizedGross, limit: dailyLoss.dayStartEquity * DAILY_MAX_LOSS_RATE, entriesBlocked: true, ...(legacy && dailyLoss.completedBuyIds.length ? { reason: 'legacy_state_without_peak' } : {}) });
    }
    // Establish the date baseline before startup settles any persisted,
    // broker-confirmed completed BUY accounting records below.
    if (dailyLossGuard && !dailyLossStateUnavailable && !dailyLoss && startupEquityDate && startupEquityDate === currentSession?.date) {
      establishDailyLoss(currentSession.date, startupEquity, { persist: false });
    }
    cooldownUntil = 0;
    setAccounting = new Map((saved.sets ?? []).map((record) => [record.tradeSetId, { ...record }]));
    if ([...setAccounting.values()].some((record) => record.known && record.date === currentSession?.date && record.entryQty > 0)) filledEntryDate = currentSession?.date ?? filledEntryDate;
    if (saved.status === 'compatible' && saved.trades.some((trade) => trade.entryPrice !== null && trade.tradeSetId && dateInET(trade.fillTimestampMs ?? 0) === currentSession?.date)) filledEntryDate = currentSession?.date ?? filledEntryDate;
    const openBuys = new Set((snapshot.orders ?? []).filter((order) => order?.side === 'buy' && ['new', 'accepted', 'pending_new', 'partially_filled', 'pending_replace', 'pending_cancel'].includes(order.status)).map((order) => order.clientOrderId ?? order.client_order_id));
    for (const record of setAccounting.values()) if (!openBuys.has(record.tradeSetId)) record.entryTerminal = true;
    const tracked = new Set(saved.status === 'compatible' ? saved.trades.map((trade) => trade.symbol) : []);
    if (tracked.size && snapshot.positions.some((row) => {
      if (!row || typeof row.symbol !== 'string' || !row.symbol) return true;
      if (!tracked.has(row.symbol)) return false;
      const qty = row.qty ?? row.quantity;
      return qty === null || qty === undefined || qty === '' || !Number.isFinite(Number(qty)) || Number(qty) < 0;
    })) throw new Error('Incomplete broker position for persisted ownership');
    if (!exposure.length && tracked.size && (cancelingBuys.size || snapshot.orders.some((order) =>
      !order || order.side === 'buy' && (tracked.has(order.symbol) || String(order.clientOrderId ?? order.client_order_id ?? '').startsWith('v5-buy-'))))) {
      throw new Error('Unresolved broker order for persisted ownership');
    }
    const continuityState = reconcileContinuity({ ...snapshot, positions: exposure }, saved);
    for (const symbol of continuityState.externalSells ?? []) { externalSellSymbols.add(symbol); positions.setExternalSell(symbol, true); }
    if (continuityState.status === 'flat') {
      for (const record of [...setAccounting.values()]) {
        if (record.known && record.date === currentSession?.date && record.entryTerminal && record.closedAt !== null && Math.abs(record.exitQty - record.entryQty) <= 1e-6) finishSetIfReady(record);
      }
      if (continuityState.trades.length) {
        recovering = continuityState.trades.some((trade) => trade.entryPrice === null);
        hydrating = true;
        try {
          for (const trade of continuityState.trades) {
            if (trade.entryPrice === null) positions.recoverLostPlace(trade);
            else positions.restoreTrade({ ...trade, reconciling: true });
            positions.markReconciling(trade.tradeId);
          }
        } finally { hydrating = false; }
      } else {
        setAccounting.clear();
        if (!dailyLossStateUnavailable) persistContinuity();
      }
    } else if (continuityState.status === 'compatible') {
      recovering = continuityState.trades.some((trade) => trade.entryPrice === null);
      for (const trade of continuityState.trades) if (trade.tradeSetId && !setAccounting.has(trade.tradeSetId)) {
        const current = now(), session = calendar.sessionFor(current);
        setAccounting.set(trade.tradeSetId, { tradeSetId: trade.tradeSetId, date: session?.date ?? sessionDate, known: false, entryQty: 0, entryCentQty: 0, exitQty: 0, exitCentQty: 0, entryTerminal: false, closedAt: null });
      }
      hydrating = true;
      try {
        for (const trade of continuityState.trades) {
          if (trade.entryPrice === null) positions.recoverLostPlace(trade);
          else positions.restoreTrade(trade);
        }
      } finally { hydrating = false; }
    } else if (exposure.length) {
      recovering = true;
      hydrating = true;
      try {
        for (const position of exposure) {
          const symbol = position.symbol;
          const sells = (snapshot.orders ?? []).filter((order) => order.side === 'sell' && order.symbol === symbol && ['new', 'accepted', 'pending_new', 'partially_filled', 'pending_replace', 'pending_cancel'].includes(order.status));
          const ownedSells = sells.filter((order) => String(order.clientOrderId ?? order.client_order_id ?? '').startsWith('v5-sell-'));
          const foreignSell = sells.some((order) => !ownedSells.includes(order));
          if (foreignSell) { externalSellSymbols.add(symbol); positions.setExternalSell(symbol, true); }
          let uncovered = Number(position.qty ?? position.quantity);
          for (const sell of ownedSells) {
            const remaining = Math.max(0, Number(sell.qty ?? 0) - Number(sell.filled_qty ?? sell.filledQty ?? 0));
            if (!remaining) continue;
            const quantity = Math.min(uncovered, remaining);
            positions.recoverLostPlace({ symbol, remainingQty: quantity, orderId: sell.id, logicalSellId: sell.clientOrderId ?? sell.client_order_id ?? null, tradeId: `recovery:${symbol}:${sell.id}` });
            uncovered -= quantity;
          }
          if (uncovered > 0) positions.recoverLostPlace({ symbol, remainingQty: uncovered });
        }
      } finally { hydrating = false; }
      persistContinuity();
      safeLedger('LOST_PLACE_RECOVERY', { positions: exposure.map((p) => ({ symbol: p.symbol, qty: p.qty ?? p.quantity })) });
    }
    if (dailyLossGuard && dailyLoss && !dailyLossStateUnavailable) persistContinuity();
    started = true;
    nextOwnershipScanAt = nowMono() + OWNERSHIP_CHECK_MS;
    tick(); return snapshot;
  }

  const activityTime = (row) => Date.parse(row?.transaction_time);
  const openSell = (order) => order?.side === 'sell' && ['new', 'accepted', 'pending_new', 'partially_filled', 'pending_replace', 'pending_cancel'].includes(String(order.status).toLowerCase());
  const knownSell = (trade, order) => trade.orderId === order.id || trade.logicalSellId === (order.clientOrderId ?? order.client_order_id);
  async function reconcileFlatSymbol(symbol, local, signature) {
    for (const trade of local) positions.markReconciling(trade.tradeId);
    if (signature !== ownershipSignature(trades().filter((trade) => trade.remainingQty > 0))) return false;
    const recoveries = local.filter((trade) => trade.entryPrice === null);
    for (const trade of recoveries) {
      positions.clearAlreadyClosed(trade.tradeId);
      safeLedger('ALREADY_CLOSED', { tradeId: trade.tradeId, symbol, qty: trade.remainingQty, reason: 'broker_current_flat' });
    }
    if (recoveries.length) persistContinuity();
    const known = local.filter((trade) => trade.entryPrice !== null);
    if (!known.length) return true;
    if (known.length !== 1 || typeof broker.getFillActivities !== 'function') return false;
    const trade = known[0];
    if (!Number.isFinite(trade.fillTimestampMs)) return false;
    const after = new Date(trade.fillTimestampMs).toISOString();
    let activities;
    try { activities = await broker.getFillActivities({ after }); } catch { return false; }
    if (!Array.isArray(activities) || signature !== ownershipSignature(trades().filter((item) => item.remainingQty > 0))) return false;
    const sellRows = activities.filter((row) => String(row?.side ?? '').toLowerCase() === 'sell');
    if (sellRows.some((row) => typeof row?.symbol !== 'string' || !row.symbol || !Number.isFinite(activityTime(row)))) return false;
    const relevant = sellRows.filter((row) => row.symbol === symbol && activityTime(row) > trade.fillTimestampMs);
    if (relevant.some((row) => row.activity_type !== 'FILL' || !row.id || row.qty === null || row.qty === undefined || row.qty === '' || !Number.isFinite(Number(row.qty)) || Number(row.qty) <= 0 || row.price === null || row.price === undefined || row.price === '' || !Number.isFinite(Number(row.price)) || Number(row.price) < 0)) return false;
    if (new Set(relevant.map((row) => row.id)).size !== relevant.length) return false;
    const own = relevant.filter((row) => trade.orderId && row.order_id === trade.orderId);
    if (own.length) {
      for (const row of own) positions.onOrderUpdate({ orderId: row.order_id, executionId: row.id, side: 'sell', event: 'fill', symbol,
        fillQty: Number(row.qty), fillPrice: Number(row.price), timestamp: row.transaction_time });
      return false;
    }
    if (!relevant.length || Math.abs(relevant.reduce((sum, row) => sum + Number(row.qty), 0) - trade.remainingQty) > 1e-9) return false;
    const qty = relevant.reduce((sum, row) => sum + Number(row.qty), 0);
    const value = relevant.reduce((sum, row) => sum + Number(row.qty) * Number(row.price), 0);
    const adopted = positions.adoptExternalFill({ tradeId: trade.tradeId, executionId: relevant.map((row) => row.id).join(','), symbol,
      fillQty: qty, fillPrice: value / qty, timestamp: relevant.at(-1).transaction_time,
      ...(new Set(relevant.map((row) => row.order_id).filter(Boolean)).size === 1 ? { orderId: relevant.find((row) => row.order_id)?.order_id } : {}) });
    if (adopted.adopted) {
      externalSellSymbols.delete(symbol);
      positions.setExternalSell(symbol, false);
      safeLedger('EXTERNAL_MANUAL_EXIT_RECONCILED', { tradeId: trade.tradeId, symbol, fills: relevant.map((row) => row.id), qty });
      return true;
    }
    return false;
  }

  async function inspectCurrentOwnership() {
    if (ownershipScan) return ownershipScan;
    const before = ownershipSignature(trades().filter((trade) => trade.remainingQty > 0));
    ownershipScan = (async () => {
      const snapshot = await broker.inspectCurrentState();
      const owned = trades().filter((trade) => trade.remainingQty > 0);
      const after = ownershipSignature(owned);
      if (before !== after || !Array.isArray(snapshot?.positions) || !Array.isArray(snapshot?.orders) ||
          !snapshot.positions.every((row) => row && typeof row.symbol === 'string' && row.symbol) ||
          entryActive() || cancelingBuys.size || entry.getState().orderStatus === 'UNKNOWN_OUTCOME') {
        return snapshot;
      }
      for (const symbol of new Set(owned.map((trade) => trade.symbol))) {
        const local = owned.filter((trade) => trade.symbol === symbol);
        const position = snapshot.positions.filter((row) => row?.symbol === symbol);
        const sells = (snapshot.orders ?? []).filter((order) => order?.symbol === symbol && openSell(order));
        const foreignSell = sells.some((order) => !local.some((trade) => knownSell(trade, order)));
        if (foreignSell !== externalSellSymbols.has(symbol)) {
          if (foreignSell) externalSellSymbols.add(symbol); else externalSellSymbols.delete(symbol);
          positions.setExternalSell(symbol, foreignSell);
        }
        const openOrder = snapshot.orders.some((order) => !order || typeof order.symbol !== 'string' || !order.symbol || order.symbol === symbol ||
          String(order.clientOrderId ?? order.client_order_id ?? '').startsWith('v5-buy-'));
        const flat = isSpyOption(symbol) && !local.some((trade) => trade.inFlight || positions.hasPendingMutation(trade.tradeId)) &&
          !openOrder && position.every((row) => {
            const qty = row.qty ?? row.quantity;
            return qty !== null && qty !== undefined && qty !== '' && Number.isFinite(Number(qty)) && Number(qty) === 0;
          });
        if (!flat) continue;
        await reconcileFlatSymbol(symbol, local, before);
        if (!hasOwnership()) { recovering = false; cooldownUntil = nowMono() + FIVE_SECONDS; setState('COOLDOWN', { until: cooldownUntil }); }
        else if (trades().some((trade) => trade.reconciling)) setState('RECONCILING');
      }
      return snapshot;
    })();
    try { return await ownershipScan; }
    finally { ownershipScan = undefined; nextOwnershipScanAt = nowMono() + OWNERSHIP_CHECK_MS; }
  }

  function onBreakout(event) {
    if (!started || state !== 'FLAT' || !canEnterDailyLoss() || cancelingBuys.size > 0 || entryActive() || nowMono() < cooldownUntil) return false;
    const session = calendar.sessionFor(now());
    const cutoff = session && (session.cutoff ? Date.parse(session.cutoff) : null);
    if (!session || session.status !== 'open' || (stopAtMs !== null && now() >= stopAtMs) || !signal.canEnter(event.timestamp ?? now()) || !signal.canEnter(now()) || localMinutes(event.timestamp ?? now()) >= buyCutoffMinuteET || localMinutes(now()) >= buyCutoffMinuteET || (Number.isFinite(cutoff) && Date.parse(event.timestamp) >= cutoff)) return false;
    setState('BUYING', event); entry.onBreakout(event); return true;
  }

  function onTrade(trade, receivedAt = now()) { return signal.onTrade(trade, receivedAt); }
  function onRawTrade(raw, receivedAt = now()) {
    const result = sip.onRawTrade(raw, receivedAt);
    sipObservation.messages++;
    sipObservation.lastMessageAt = new Date(receivedAt).toISOString();
    if (result?.accepted === false) { sipObservation.rejected++; sipObservation.lastRejectedReason = result.reason; }
    return result;
  }
  function onMarketDataStatus(status) { return signal.onMarketDataStatus(status); }
  function onQuote(quote) { positions.onQuote(quote); }

  function onOrderUpdate(update) {
    const preUpdateTrades = update?.side === 'sell' ? trades().filter((trade) => trade.symbol === update.symbol && trade.remainingQty > 0) : [];
    const knownSell = update?.side === 'sell' && (positions.isKnownOrderUpdate(update) || String(update.clientOrderId ?? update.client_order_id ?? '').startsWith('v5-sell-') || preUpdateTrades.some((trade) =>
      trade.orderId === update.orderId || trade.logicalSellId === update.clientOrderId || trade.orderId === update.replaces || trade.orderId === update.replacedBy));
    if (cancelingBuys.has(update.orderId) && ['canceled', 'rejected', 'expired'].includes(update.event)) cancelingBuys.delete(update.orderId);
    entry.onOrderUpdate(update); positions.onOrderUpdate(update); recordEntryState();
    if (update.side === 'sell' && !knownSell && ['fill', 'partial_fill'].includes(String(update.event).toLowerCase())) {
      if (preUpdateTrades.length === 1) {
        externalSellSymbols.add(update.symbol);
        positions.setExternalSell(update.symbol, true);
        positions.markReconciling(preUpdateTrades[0].tradeId);
        const adopted = positions.adoptExternalFill({ tradeId: preUpdateTrades[0].tradeId, executionId: update.executionId, symbol: update.symbol,
          fillQty: update.fillQty, fillPrice: update.fillPrice, timestamp: update.timestamp, orderId: update.orderId });
        if (adopted.adopted) { externalSellSymbols.delete(update.symbol); positions.setExternalSell(update.symbol, false); }
      }
    }
    const fillSet = update.clientOrderId ? setAccounting.get(update.clientOrderId) : null;
    if (fillSet && update.side === 'buy' && ['fill', 'canceled', 'cancelled', 'rejected', 'expired', 'done'].includes(String(update.event).toLowerCase())) {
      fillSet.entryTerminal = true;
      persistContinuity();
      finishSetIfReady(fillSet);
    }
    if (state !== 'COOLDOWN' && update.side === 'buy' && cancelingBuys.size === 0 && !hasOwnership() && !entryActive() && ['canceled', 'rejected', 'expired'].includes(update.event)) setState('FLAT');
  }

  function scheduleDeadline() {
    clearTimeout(deadlineTimer);
    const deadline = entry.nextDeadline();
    if (Number.isFinite(deadline) && deadline > nowMono()) deadlineTimer = setTimeout(() => { deadlineTimer = undefined; entry.tick(); scheduleDeadline(); }, deadline - nowMono());
  }

  function emitStatus(current, session) {
    if (nowMono() < nextStatusAt) return;
    nextStatusAt = nowMono() + FIVE_SECONDS;
    try {
      const signalStatus = signal.getStatus(current);
      const blockers = [];
      if (signalStatus.entryBlocker) blockers.push(signalStatus.entryBlocker);
      if (session?.status !== 'open') blockers.push('MARKET_CLOSED');
      if (localMinutes(current) >= buyCutoffMinuteET || (session?.cutoff && current >= Date.parse(session.cutoff))) blockers.push('ENTRY_CUTOFF');
      if (stopAtMs !== null && current >= stopAtMs) blockers.push('ENTRIES_STOPPED');
      if (filledEntryStateUnavailable) blockers.push('ENTRY_HISTORY_UNAVAILABLE');
      if (filledEntryDate === sessionDate && sessionDate !== null) blockers.push('DAILY_ENTRY_USED');
      if (dailyLossGuard && (dailyLossStateUnavailable || !dailyLoss || dailyLoss.date !== sessionDate)) blockers.push('DAILY_GUARD_UNAVAILABLE');
      if (dailyLoss?.tripped) blockers.push('DAILY_LOSS_LIMIT');
      if (cancelingBuys.size) blockers.push('BUY_CANCEL_PENDING');
      if (nowMono() < cooldownUntil) blockers.push('COOLDOWN');
      if (state !== 'FLAT') blockers.push(state);
      if (entryActive()) blockers.push('ENTRY_IN_PROGRESS');
      const selected = entry.getState();
      const event = {
        type: 'runtime_status', at: new Date(current).toISOString(), date: sessionDate, state,
        entryEligible: started && !blockers.length && signalStatus.entryEligible,
        blockers, signal: signalStatus, sip: { ...sipObservation,
          lastMessageAgeMs: sipObservation.lastMessageAt === null ? null : current - Date.parse(sipObservation.lastMessageAt) },
        entry: { state: selected.state, reason: selected.reason ?? null, symbol: selected.contract?.symbol ?? null,
          signalAt: selected.breakout?.timestamp ?? null, direction: selected.breakout?.direction ?? null,
          bid: selected.quote?.bid ?? null, ask: selected.quote?.ask ?? null,
          frozenCap: selected.cap, orderId: selected.orderId },
        filledEntryDate, realizedPnlUsd: dailyLoss?.cumulativeRealizedGross ?? null,
        held: trades().filter((t) => t.remainingQty > 0).map((t) => ({ symbol: t.symbol, qty: t.remainingQty,
          entryPrice: t.entryPrice, mfeCents: t.mfeCents, maeCents: t.maeCents, reconciling: t.reconciling,
          sellLatched: t.sellLatched, externalSellOpen: externalSellSymbols.has(t.symbol) })),
      };
      Promise.resolve(telemetry(event)).catch(() => {});
    } catch {}
  }

  function tick() {
    const current = now();
    const session = calendar.sessionFor(current);
    if (session?.date && session?.open && current < Date.parse(session.close) && (session.status === 'open' || current < Date.parse(session.open))) beginSession(session, current);
    else if (sessionDate && session?.date === sessionDate) finalizeLedger(sessionDate);
    entry.tick();
    positions.reconcilePending();
    if (liquidateAt !== null && current >= liquidateAt) positions.liquidate();
    if (hasLongOwnership()) setState(trades().some((trade) => trade.reconciling) ? 'RECONCILING' : recovering ? 'RECOVERING' : 'MANAGING');
    else if (state === 'COOLDOWN' && nowMono() >= cooldownUntil && !entryActive() && !hasOwnership()) {
      entry.ready?.();
      setState(session?.status === 'open' ? 'FLAT' : 'WAITING', session?.status === 'open' ? {} : { nextDate: session?.nextDate, nextOpen: session?.nextOpen });
    }
    else if (!hasOwnership() && state !== 'BLOCKED_OWNERSHIP' && state !== 'COOLDOWN' && state !== 'BUYING' && entryActive() === false && session?.status !== 'open') setState('WAITING', { nextDate: session?.nextDate, nextOpen: session?.nextOpen });
    else if (!hasOwnership() && ['STARTING', 'WAITING'].includes(state) && session?.status === 'open' && cancelingBuys.size === 0) setState(nowMono() < cooldownUntil ? 'COOLDOWN' : 'FLAT');
    if (hasOwnership() && nowMono() >= nextOwnershipScanAt && !ownershipScan) void inspectCurrentOwnership().catch(() => {});
    scheduleDeadline();
    emitStatus(current, session);
  }

  function onExit(event) {
    safeLedger('EXIT', event);
    const record = event.tradeSetId ? setAccounting.get(event.tradeSetId) : null;
    const priceCents = cents(event.price);
    if (record && record.known && priceCents !== null && Number.isFinite(Number(event.qty)) && Number(event.qty) > 0) {
      record.exitQty += Number(event.qty);
      record.exitCentQty += priceCents * Number(event.qty);
      if (Math.abs(record.exitQty - record.entryQty) <= 1e-6) record.closedAt = now();
    }
    persistContinuity();
    if (!hasLongOwnership()) {
      if (recovering) {
        void broker.inspectCurrentState().then((current) => {
          const open = (current.positions ?? []).some((p) => Number(p.qty ?? p.quantity ?? 0) !== 0 && isSpyOption(p.symbol));
          if (!open) { recovering = false; setAccounting.clear(); continuity.save([], { pause: null, sets: [] }); cooldownUntil = nowMono() + FIVE_SECONDS; setState('COOLDOWN', { until: cooldownUntil }); }
        }).catch(() => {});
      } else { cooldownUntil = nowMono() + FIVE_SECONDS; setState('COOLDOWN', { until: cooldownUntil }); }
    }
    if (record) finishSetIfReady(record);
    else persistContinuity();
  }
  async function start() { await startup(); timer = setInterval(tick, 500); scheduleDeadline(); return stop; }
  function stop() { clearInterval(timer); clearTimeout(deadlineTimer); timer = deadlineTimer = undefined; }
  return {
    start, stop, startup, tick, onTrade, onRawTrade, onMarketDataStatus, onQuote, onOrderUpdate,
    inspectCurrentOwnership, hasOwnership,
    getState: () => {
      const entrySnapshot = entry.getState();
      return { state, sessionDate, ledgerDate, cooldownUntil, filledEntryDate, blockers: [...executionIssues], ...(dailyLossGuard ? { dailyLoss: dailyLoss ? { ...dailyLoss, completedBuyIds: [...dailyLoss.completedBuyIds] } : null } : {}), entry: entrySnapshot };
    },
    nextDeadline: () => entry.nextDeadline(),
    stopEntries: () => { stopAtMs = Math.min(stopAtMs ?? Infinity, now()); tick(); }
  };
}
