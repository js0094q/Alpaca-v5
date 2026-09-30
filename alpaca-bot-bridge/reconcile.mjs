import { createHash } from 'node:crypto';
import { brokerSnapshot, request } from './broker.mjs';
import { PAPER_ACCOUNT_ID, redact } from './config.mjs';
import { localSnapshot, readLocalHistory } from './runtime.mjs';

const optionSymbol = (value) => /^SPY\d{6}[CP]\d{8}$/u.test(String(value ?? ''));
const openStatuses = new Set(['new', 'accepted', 'pending_new', 'partially_filled', 'pending_replace', 'pending_cancel']);
const num = (value) => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const envelopeRows = (value) => value?.ok && Array.isArray(value.data) ? value.data : null;
const envelopeEvidence = (value) => ({ ok: Boolean(value?.ok), status: value?.status ?? null, request: value?.request ?? null, ...(value?.error ? { error: value.error } : {}) });
const q = (row) => num(row?.qty ?? row?.quantity);
const orderId = (row) => row?.id ?? row?.order_id ?? null;
const clientId = (row) => row?.client_order_id ?? row?.clientOrderId ?? null;

function localTradeRows(continuity) {
  if (continuity?.status !== 'available' || !Array.isArray(continuity.trades)) return null;
  if (!continuity.trades.every((trade) => trade && typeof trade.tradeId === 'string' && optionSymbol(trade.symbol) && num(trade.remainingQty) > 0)) return null;
  return continuity.trades;
}

function telemetryFiles(local) {
  return Array.isArray(local?.telemetry?.files) ? local.telemetry.files : [];
}

function telemetryLines(local) {
  return telemetryFiles(local).flatMap((file) => Array.isArray(file?.events) ? file.events : []);
}

function telemetryRows(local) {
  const events = [];
  for (const line of telemetryLines(local)) {
    try {
      const row = JSON.parse(line);
      if (row && typeof row.event === 'string') events.push(row);
    } catch { /* A partial final trace line is unavailable evidence. */ }
  }
  return events;
}

function postExitWindows(local) {
  return Array.isArray(local?.postExitEvidence?.windows) ? local.postExitEvidence.windows : [];
}

function ledgerRows(lines = []) {
  const events = [];
  for (const line of lines) {
    const match = /^\[[^\]]*\]\s+(\S+)(?:\s+(.*))?$/u.exec(line);
    if (!match) continue;
    const fields = Object.fromEntries((match[2] ?? '').matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9_]*)=([^\s]+)/gu).map((item) => [item[1], item[2]]));
    events.push({ event: match[1], ...fields });
  }
  return events;
}

function stateError(envelope) {
  if (!envelope?.ok) return { status: envelope?.status ?? null, code: envelope?.error?.code ?? null, message: envelope?.error?.message ?? 'Snapshot request failed.' };
  if (!Array.isArray(envelope.data)) return { status: envelope.status ?? null, code: 'INCOMPLETE_RESPONSE', message: 'Snapshot response did not contain a complete row list.' };
  return null;
}

function matchedAccountHash(account) {
  return typeof account?.id === 'string' && account.id
    ? createHash('sha256').update(account.id).digest('hex')
    : null;
}

function orderIsActive(row) { return openStatuses.has(String(row?.status ?? '').toLowerCase()); }

function latestByClientId(orders, id) {
  const matches = orders.filter((row) => clientId(row) === id);
  if (matches.length < 2) return matches[0] ?? null;
  for (const match of matches) {
    const leaf = replaceLeaf(orders, match).order;
    if (leaf && orderIsActive(leaf)) return leaf;
  }
  return matches.at(-1);
}

function replaceLeaf(orders, row) {
  let current = row;
  const seen = new Set();
  while (current?.replaced_by && !seen.has(current.replaced_by)) {
    seen.add(orderId(current));
    const next = orders.find((candidate) => orderId(candidate) === current.replaced_by);
    if (!next) return { order: current, incomplete: true };
    current = next;
  }
  return { order: current, incomplete: false };
}

function executionKey(value) {
  const text = String(value ?? '');
  const match = /::([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.exec(text);
  return match ? match[1].toLowerCase() : text;
}

// Join identifiers only; price/time proximity is never proof of execution.
export function executionLinks(local, broker, trace = telemetryRows(local)) {
  const events = ledgerRows(local?.ledger?.events ?? []);
  const fills = envelopeRows(broker?.fills) ?? [];
  const orders = envelopeRows(broker?.orders) ?? [];
  const entries = new Map(events.filter((row) => row.event === 'FILL' && row.tradeId).map((row) => [row.tradeId, row]));
  return events.filter((row) => ['FILL', 'EXIT'].includes(row.event)).map((row) => {
    const fill = fills.find((item) => executionKey(item.id ?? item.execution_id) === executionKey(row.executionId)
      && item.symbol === row.symbol && item.side === (row.event === 'FILL' ? 'buy' : 'sell'));
    const order = fill && orders.find((item) => orderId(item) === fill.order_id);
    const proof = fill && trace.find((item) => item.fields?.tradeId === row.tradeId
      && item.fields?.executionId === row.executionId && (!item.fields.symbol || item.fields.symbol === row.symbol)
      && (!item.fields.orderId || item.fields.orderId === fill.order_id));
    const linkedTrace = proof ? trace.filter((item) => item.runId === proof.runId && item.fields?.tradeId === row.tradeId) : [];
    const entry = linkedTrace.find((item) => item.event === 'entry_fill_link');
    const signal = entry && trace.find((item) => item.runId === entry.runId && item.event === 'signal_accepted_for_selection'
      && item.fields?.signalId === entry.fields.signalId);
    const tradeSetId = entry?.fields?.tradeSetId ?? entry?.fields?.entrySetId ?? entry?.fields?.clientOrderId ?? null;
    const candidates = entry ? trace.filter((item) => item.runId === entry.runId && item.event === 'contract_candidate'
      && item.fields?.signalId === entry.fields.signalId) : [];
    const decisionEvents = linkedTrace.filter((item) => ['position_quote_accepted', 'lot_decision', 'sell_latch', 'sell_request', 'position_exit'].includes(item.event));
    const entryEvents = entry ? trace.filter((item) => item.runId === entry.runId
      && ['signal_accepted_for_selection', 'contract_candidate', 'entry_construction', 'entry_set', 'buy_submit', 'buy_response', 'buy_reprice', 'buy_api_error', 'buy_cancel_request'].includes(item.event)
      && (item.fields?.signalId === entry.fields.signalId || item.fields?.tradeSetId === tradeSetId || item.fields?.entrySetId === tradeSetId)) : [];
    const entryEvent = entries.get(row.tradeId);
    const entryBrokerFill = entryEvent && fills.find((item) => executionKey(item.id ?? item.execution_id) === executionKey(entryEvent.executionId)
      && item.symbol === entryEvent.symbol && item.side === 'buy');
    const entryOrder = entryBrokerFill && orders.find((item) => orderId(item) === entryBrokerFill.order_id);
    const linkedSetId = tradeSetId ?? entryOrder?.client_order_id ?? null;
    const entryPrice = num(entryBrokerFill?.price);
    const exitPrice = row.event === 'EXIT' ? num(fill?.price) : null;
    const quantity = num(row.qty) ?? (row.event === 'FILL' ? 1 : null);
    const contractSize = num(local?.continuity?.trades?.find((item) => item.tradeId === row.tradeId)?.contractSize)
      ?? num(linkedTrace.find((item) => item.fields?.contractSize)?.fields?.contractSize)
      ?? num(broker?.contractMetadata?.[row.symbol]?.contractSize);
    const contractSizeSource = local?.continuity?.trades?.find((item) => item.tradeId === row.tradeId)?.contractSizeSource
      ?? linkedTrace.find((item) => item.fields?.contractSizeSource)?.fields?.contractSizeSource
      ?? broker?.contractMetadata?.[row.symbol]?.source ?? null;
    const postExit = row.event === 'EXIT' ? postExitWindows(local).filter((window) => window.tradeId === row.tradeId
      && window.entryExecutionId === entryEvent?.executionId && window.exitExecutionId === row.executionId
      && window.symbol === row.symbol && (!tradeSetId || window.entrySetId === tradeSetId)) : [];
    const pnl = row.event === 'EXIT' && fill && entryBrokerFill && entryPrice !== null && exitPrice !== null && quantity !== null && contractSize !== null
      ? Math.round((exitPrice - entryPrice) * quantity * contractSize * 100) / 100 : null;
    return {
      tradeId: row.tradeId ?? null, ledgerEvent: row.event, executionId: row.executionId ?? null, symbol: row.symbol ?? null,
      localLotQuantity: num(row.qty) ?? (row.event === 'FILL' ? 1 : null),
      match: fill ? 'execution_id_symbol_side' : 'unknown_in_bounded_broker_history',
      brokerActivityId: fill?.id ?? null, brokerOrderId: fill?.order_id ?? null,
      brokerClientOrderId: order?.client_order_id ?? null,
      brokerFill: fill ? { qty: fill.qty, quantityScope: 'broker_execution_may_cover_multiple_lots', price: fill.price, transactionTime: fill.transaction_time } : null,
      entrySetId: linkedSetId, tradeSetId: linkedSetId,
      actionSource: entry?.fields?.actionSource ?? 'Unknown',
      actualEntryFillPrice: entryPrice,
      actualExitFillPrice: exitPrice,
      contractSize, contractSizeSource,
      realizedPnlUsd: pnl,
      pnlStatus: row.event !== 'EXIT' ? 'not_an_exit' : pnl === null ? 'unknown_missing_exact_fill_price_quantity_or_contract_size' : 'exact_execution_link',
      postExitEvidence: postExit.map((window) => ({ status: window.status, coverage: window.coverage,
        events: (window.events ?? []).filter((item) => ['POST_EXIT_START', 'POST_EXIT_QUOTE', 'POST_EXIT_GAP', 'POST_EXIT_END'].includes(item.event)) })),
      postExitStatus: row.event !== 'EXIT' ? 'not_an_exit' : postExit.length ? postExit[0].status : 'unknown_no_exact_account_scoped_window',
      signal: signal ? { runId: signal.runId, ...signal.fields } : null,
      entryEvidence: entryEvents.map(({ runId, sequence, event, wallTimeMs, fields }) => ({ runId, sequence, event, wallTimeMs, ...fields })),
      candidates: candidates.map(({ runId, sequence, event, wallTimeMs, fields }) => ({ runId, sequence, event, wallTimeMs, ...fields })),
      quotesAndThresholds: decisionEvents.map(({ runId, sequence, event, wallTimeMs, fields }) => ({ runId, sequence, event, wallTimeMs, ...fields })),
      localActiveLot: local?.continuity?.trades?.find((item) => item.tradeId === row.tradeId) ?? null,
      telemetry: linkedTrace.filter((item) => ['entry_fill_link', 'position_quote_accepted', 'lot_decision', 'sell_latch', 'sell_request', 'position_exit', 'POST_EXIT_START', 'POST_EXIT_QUOTE', 'POST_EXIT_END', 'POST_EXIT_GAP'].includes(item.event))
        .slice(-20).map(({ runId, sequence, event, wallTimeMs, fields }) => ({ runId, sequence, event, wallTimeMs, fields })),
    };
  });
}

function compareLedger(trades, events, truncated, fills, fillsTruncated) {
  if (!events.length || truncated) return { status: 'unknown', reason: truncated ? 'LEDGER_MAY_BE_TRUNCATED' : 'LEDGER_UNAVAILABLE' };
  const fillEvents = events.filter((item) => item.event === 'FILL');
  if (fillEvents.some((event) => !event.executionId)) return { status: 'unknown', reason: 'LEDGER_FILL_ID_UNAVAILABLE' };
  const localExecutions = new Map();
  for (const event of events.filter((item) => ['FILL', 'EXIT'].includes(item.event))) {
    if (!event.executionId) {
      if (event.event === 'FILL') return { status: 'unknown', reason: 'LEDGER_FILL_ID_UNAVAILABLE' };
      continue;
    }
    const key = executionKey(event.executionId);
    const row = localExecutions.get(key) ?? { symbol: event.symbol, side: event.event === 'FILL' ? 'buy' : 'sell', qty: 0, ledgerExecutionId: event.executionId };
    if (event.symbol && row.symbol && event.symbol !== row.symbol) return { status: 'discrepancy', reason: 'LEDGER_EXECUTION_SYMBOL_MISMATCH', executionId: event.executionId };
    row.symbol ??= event.symbol;
    row.qty += num(event.qty) ?? (event.event === 'FILL' ? 1 : 0);
    localExecutions.set(key, row);
  }
  const brokerExecutions = new Map();
  for (const fill of fills) {
    const rawId = fill?.id ?? fill?.execution_id;
    if (!rawId) continue;
    const key = executionKey(rawId);
    const row = brokerExecutions.get(key) ?? { id: rawId, symbol: fill.symbol, side: fill.side, qty: 0 };
    row.qty += num(fill.qty) ?? 0;
    brokerExecutions.set(key, row);
  }
  const unmatched = [];
  for (const [key, local] of localExecutions) {
    const broker = brokerExecutions.get(key);
    if (!broker) { unmatched.push(local.ledgerExecutionId); continue; }
    if ((local.symbol && broker.symbol && local.symbol !== broker.symbol) || (broker.side && broker.side !== local.side) || (local.qty && broker.qty && local.qty !== broker.qty)) {
      return { status: 'discrepancy', reason: 'LEDGER_BROKER_FILL_MISMATCH', executionId: local.ledgerExecutionId, brokerActivityId: broker.id };
    }
  }
  if (unmatched.length && fillsTruncated) return { status: 'unknown', reason: 'BROKER_FILL_HISTORY_MAY_BE_TRUNCATED', unmatchedExecutionIds: unmatched };
  if (unmatched.length) return { status: 'discrepancy', reason: 'LEDGER_FILL_MISSING_FROM_BROKER', unmatchedExecutionIds: unmatched };
  const ledgerOpen = new Map();
  for (const event of events) {
    if (!event.tradeId || !optionSymbol(event.symbol)) continue;
    if (event.event === 'FILL') {
      const amount = num(event.qty) ?? 1;
      ledgerOpen.set(event.tradeId, { symbol: event.symbol, qty: (ledgerOpen.get(event.tradeId)?.qty ?? 0) + amount });
    } else if (event.event === 'EXIT') {
      const prior = ledgerOpen.get(event.tradeId);
      const amount = num(event.qty) ?? (prior?.qty ?? 0);
      if (prior) {
        prior.qty -= amount;
        if (prior.qty <= 0) ledgerOpen.delete(event.tradeId);
      }
    }
  }
  if (!trades) return { status: 'unknown', reason: 'CONTINUITY_UNAVAILABLE', fills: 'matched' };
  const active = new Map(trades.map((trade) => [trade.tradeId, { symbol: trade.symbol, qty: Number(trade.remainingQty) }]));
  if ([...active].some(([id, value]) => {
    const ledger = ledgerOpen.get(id);
    return !ledger || ledger.symbol !== value.symbol || ledger.qty !== value.qty;
  })) return { status: 'discrepancy', reason: 'CONTINUITY_LEDGER_MISMATCH' };
  if ([...ledgerOpen.keys()].some((id) => !active.has(id))) return { status: 'discrepancy', reason: 'LEDGER_HAS_UNTRACKED_ACTIVE_FILL' };
  return { status: 'matched' };
}

function traceUnknownBuys(local) {
  const events = telemetryRows(local);
  const errors = new Map();
  for (const event of events) {
    const fields = event.fields ?? {};
    if (event.event === 'buy_api_error' && fields.entrySetId) errors.set(fields.entrySetId, fields);
  }
  const pending = new Map();
  for (const event of events) {
    if (event.event !== 'entry_state') continue;
    const fields = event.fields ?? {};
    if (!fields.entrySetId) continue;
    if (fields.orderStatus === 'UNKNOWN_OUTCOME' || fields.state === 'UNKNOWN_OUTCOME') pending.set(fields.entrySetId, { clientOrderId: fields.entrySetId, orderId: fields.orderId ?? null, brokerError: errors.get(fields.entrySetId) ?? null });
    else if (['WORKING', 'FILLED', 'DONE'].includes(fields.state)) pending.delete(fields.entrySetId);
  }
  if (local?.entry?.status === 'UNKNOWN_OUTCOME' && local.entry.clientOrderId) pending.set(local.entry.clientOrderId, { clientOrderId: local.entry.clientOrderId, orderId: local.entry.orderId ?? null, brokerError: local.entry.brokerError ?? null });
  return [...pending.values()];
}

function recentBuyErrors(local) {
  return telemetryRows(local).filter((event) => event.event === 'buy_api_error').map(({ fields = {} }) => ({
    clientOrderId: fields.entrySetId ?? null,
    orderId: fields.orderId ?? null,
    httpStatus: fields.httpStatus ?? null,
    code: fields.code ?? null,
    message: fields.message ?? null,
  }));
}

export function createBrokerReconciler({ getBrokerSnapshot = brokerSnapshot, getLocalSnapshot = localSnapshot, getRequest = request } = {}) {
  return async function brokerReconcile() {
    const mode = 'paper';
    const unknowns = [];
    const discrepancies = [];
    let broker;
    let local;
    try {
      [broker, local] = await Promise.all([getBrokerSnapshot(), getLocalSnapshot('paper')]);
    } catch (error) {
      return redact({ mode, status: 'unknown', unknowns: [{ code: 'SNAPSHOT_FAILED', message: error?.code ?? 'A required snapshot could not be read.' }], discrepancies: [] });
    }
    if (broker?.mode !== mode || local?.mode !== mode) unknowns.push({ code: 'MODE_MISMATCH', message: 'Snapshot mode did not match the requested mode.' });
    const account = broker?.account?.data;
    const accountHash = matchedAccountHash(account);
    if (account?.id && account.id !== PAPER_ACCOUNT_ID) unknowns.push({ code: 'PAPER_ACCOUNT_MISMATCH', message: 'Broker account does not match the V5 PAPER account.' });
    if (!accountHash) unknowns.push({ code: 'ACCOUNT_ID_UNAVAILABLE', message: 'The broker account identity is unavailable.' });
    const localAccount = accountHash && local?.accountHash === accountHash ? local : null;
    if (!localAccount) unknowns.push({ code: 'LOCAL_ACCOUNT_STATE_UNAVAILABLE', message: 'No local V5 state was found for this broker account.' });

    const rows = {
      orders: envelopeRows(broker?.orders),
      fills: envelopeRows(broker?.fills),
      positions: envelopeRows(broker?.positions),
    };
    for (const key of Object.keys(rows)) {
      const error = stateError(broker?.[key]);
      if (error) unknowns.push({ code: `BROKER_${key.toUpperCase()}_UNAVAILABLE`, ...error });
    }
    const accountEnvelopeError = !broker?.account?.ok || !account || typeof account !== 'object' || Array.isArray(account)
      ? { status: broker?.account?.status ?? null, code: broker?.account?.error?.code ?? 'INCOMPLETE_RESPONSE', message: broker?.account?.error?.message ?? 'Account response did not contain an account object.' }
      : null;
    if (accountEnvelopeError) unknowns.push({ code: 'BROKER_ACCOUNT_UNAVAILABLE', ...accountEnvelopeError });
    const trades = localTradeRows(localAccount?.continuity);
    if (!trades) unknowns.push({ code: 'CONTINUITY_UNAVAILABLE', message: 'Active V5 continuity state is missing or incompatible.' });

    const unknownBuys = traceUnknownBuys(localAccount);
    const buyErrors = recentBuyErrors(localAccount);
    const orders = rows.orders ?? [];
    const telemetryFilesRead = telemetryFiles(localAccount);
    const telemetryTruncated = Boolean(localAccount && (localAccount.telemetry?.status !== 'available' || localAccount.telemetry?.truncated || telemetryFilesRead.some((file) => file.truncated) || telemetryFilesRead.length >= 10));
    if (telemetryTruncated) unknowns.push({ code: 'UNKNOWN_OUTCOME_HISTORY_INCOMPLETE', message: 'The selected account trace history is missing, bounded, or truncated.' });
    if (broker?.orderHistoryMayBeTruncated) unknowns.push({ code: 'BROKER_ORDER_HISTORY_MAY_BE_TRUNCATED', message: 'The broker order history reached its requested limit.' });
    if (broker?.openOrdersMayBeTruncated) unknowns.push({ code: 'BROKER_OPEN_ORDERS_MAY_BE_TRUNCATED', message: 'The broker open-order list reached its requested limit.' });
    if (broker?.openOrders && !broker.openOrders.ok) unknowns.push({ code: 'BROKER_OPEN_ORDERS_UNAVAILABLE', ...stateError(broker.openOrders) });
    for (const outcome of unknownBuys) {
      let found = outcome.orderId ? orders.find((item) => orderId(item) === outcome.orderId) : null;
      found ??= latestByClientId(orders, outcome.clientOrderId);
      if (!found) {
        let lookup;
        try { lookup = await getRequest(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(outcome.clientOrderId)}`); }
        catch (error) { lookup = { ok: false, status: null, request: { method: 'GET' }, error: { code: error?.code ?? 'LOOKUP_FAILED', message: 'The order lookup failed.' } }; }
        outcome.lookup = envelopeEvidence(lookup);
        if (lookup?.ok && lookup.data && typeof lookup.data === 'object' && !Array.isArray(lookup.data)) found = lookup.data;
        else {
          outcome.lookupError = lookup?.error ?? { code: 'ORDER_NOT_FOUND', message: 'No broker order matched the uncertain client order ID.' };
          unknowns.push({ code: 'BUY_OUTCOME_UNRESOLVED', clientOrderId: outcome.clientOrderId });
        }
      }
      if (found) {
        outcome.resolution = { orderId: orderId(found), status: found.status ?? 'unknown', clientOrderId: clientId(found) ?? outcome.clientOrderId, ...(found.reject_reason || found.failure_reason ? { brokerReason: found.reject_reason ?? found.failure_reason } : {}) };
      }
    }

    let ledgerCheck;
    const ledger = Array.isArray(localAccount?.ledger?.events) ? localAccount.ledger.events : [];
    const ledgerTruncated = localAccount?.ledger?.truncated ?? localAccount?.ledgerMayBeTruncated ?? ledger.length >= 200;
    const fillRows = rows.fills ?? [];
    const parsedLedger = ledgerRows(ledger);
    if (localAccount?.ledger?.status !== 'available') ledgerCheck = { status: 'unknown', reason: 'LEDGER_UNAVAILABLE' };
    else if (parsedLedger.length !== ledger.length) ledgerCheck = { status: 'unknown', reason: 'LEDGER_CONTAINS_UNREADABLE_ROWS' };
    else ledgerCheck = compareLedger(trades, parsedLedger, ledgerTruncated, fillRows, broker?.fillsMayBeTruncated ?? fillRows.length >= 100);
    if (ledgerCheck.status === 'unknown') unknowns.push({ code: ledgerCheck.reason, message: 'The local ledger cannot establish complete active-trade state.' });
    if (ledgerCheck.status === 'discrepancy') discrepancies.push({ code: ledgerCheck.reason, ...(ledgerCheck.unmatchedExecutionIds ? { unmatchedExecutionIds: ledgerCheck.unmatchedExecutionIds } : {}), ...(ledgerCheck.executionId ? { executionId: ledgerCheck.executionId } : {}) });

    if (rows.positions) {
      const localQty = new Map();
      for (const trade of trades ?? []) localQty.set(trade.symbol, (localQty.get(trade.symbol) ?? 0) + Number(trade.remainingQty));
      const brokerQty = new Map();
      for (const position of rows.positions.filter((row) => optionSymbol(row.symbol))) {
        const quantity = q(position);
        if (quantity === null) { unknowns.push({ code: 'POSITION_QUANTITY_UNAVAILABLE', symbol: position.symbol }); continue; }
        brokerQty.set(position.symbol, (brokerQty.get(position.symbol) ?? 0) + quantity);
        if (quantity < 0) discrepancies.push({ code: 'UNINTENDED_SHORT', symbol: position.symbol, quantity });
      }
      const symbols = new Set([...localQty.keys(), ...brokerQty.keys()]);
      for (const symbol of symbols) {
        const localQuantity = localQty.get(symbol) ?? 0;
        const brokerQuantity = brokerQty.get(symbol) ?? 0;
        if (trades && localQuantity !== brokerQuantity) discrepancies.push({ code: 'POSITION_MISMATCH', symbol, localQuantity, brokerQuantity });
      }

      const openOrderRows = envelopeRows(broker?.openOrders) ?? orders.filter(orderIsActive);
      const allOrders = [...new Map([...orders, ...openOrderRows].map((row) => [orderId(row), row])).values()].filter((row) => optionSymbol(row.symbol));
      const openOrders = openOrderRows;
      const activeSells = [];
      for (const candidate of openOrders.filter((row) => optionSymbol(row.symbol) && row.side === 'sell' && orderIsActive(row))) {
        if (candidate.replaced_by) continue;
        activeSells.push(candidate);
      }
      const seenActive = new Set();
      for (const trade of trades ?? []) {
        if (!trade.sellLatched) continue;
        const initial = allOrders.find((row) => orderId(row) === trade.orderId || clientId(row) === trade.logicalSellId);
        if (!initial) {
          if (trade.orderId || trade.logicalSellId) unknowns.push({ code: 'SELL_ORDER_UNAVAILABLE', tradeId: trade.tradeId });
          continue;
        }
        const leaf = replaceLeaf(allOrders, initial);
        if (leaf.incomplete) unknowns.push({ code: 'SELL_REPLACEMENT_LINEAGE_INCOMPLETE', tradeId: trade.tradeId });
        if (leaf.order && orderIsActive(leaf.order)) seenActive.add(orderId(leaf.order));
      }
      const sellsBySymbol = new Map();
      for (const sell of activeSells) {
        const quantity = num(sell.qty) === null ? null : Math.max(0, Number(sell.qty) - (num(sell.filled_qty ?? sell.filledQty) ?? 0));
        if (quantity === null) { unknowns.push({ code: 'SELL_QUANTITY_UNAVAILABLE', orderId: orderId(sell) }); continue; }
        sellsBySymbol.set(sell.symbol, (sellsBySymbol.get(sell.symbol) ?? 0) + quantity);
        if (!seenActive.has(orderId(sell)) && (trades ?? []).some((trade) => trade.symbol === sell.symbol && trade.sellLatched)) discrepancies.push({ code: 'UNLINKED_SELL_ORDER', orderId: orderId(sell), symbol: sell.symbol });
      }
      for (const [symbol, quantity] of sellsBySymbol) {
        const owned = Math.max(0, brokerQty.get(symbol) ?? 0);
        if (quantity > owned) discrepancies.push({ code: 'EXCESS_SELL', symbol, openSellQuantity: quantity, longPositionQuantity: owned });
      }
    }

    const status = unknowns.length ? 'unknown' : discrepancies.length ? 'discrepancy' : 'matched';
    const links = executionLinks(localAccount, broker);
    return redact({ mode, capturedAt: broker?.capturedAt ?? null, accountHash, status, executionLinks: links, authority: { execution: "broker", decisions: "local_telemetry", monitoring: "non_authoritative" }, local: { continuity: localAccount?.continuity?.status ?? 'unavailable', ledger: { ...ledgerCheck, sourceStatus: localAccount?.ledger?.status ?? 'unavailable' }, accountFound: Boolean(localAccount), ledgerLines: localAccount?.ledger?.events?.length ?? null, telemetryLines: telemetryLines(localAccount).length, telemetryStatus: localAccount?.telemetry?.status ?? 'unavailable', entry: localAccount?.entry ?? { status: 'unavailable' } }, broker: { account: envelopeEvidence(broker?.account), orders: envelopeEvidence(broker?.orders), openOrders: envelopeEvidence(broker?.openOrders), fills: envelopeEvidence(broker?.fills), positions: envelopeEvidence(broker?.positions), orderHistoryMayBeTruncated: Boolean(broker?.orderHistoryMayBeTruncated), openOrdersMayBeTruncated: Boolean(broker?.openOrdersMayBeTruncated), fillsMayBeTruncated: Boolean(broker?.fillsMayBeTruncated) }, unknowns, discrepancies, unknownBuyOutcomes: unknownBuys, buyErrors });
  };
}

export async function readContractSize(symbol, getRequest = request) {
  const match = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/u.exec(String(symbol ?? ''));
  if (!match) return null;
  const [, underlying, year, month, day, side, strikeDigits] = match;
  const query = new URLSearchParams({ underlying_symbols: underlying, expiration_date: `20${year}-${month}-${day}`,
    type: side === 'C' ? 'call' : 'put', strike_price_gte: String(Number(strikeDigits) / 1000),
    strike_price_lte: String(Number(strikeDigits) / 1000), limit: '10000' });
  for (const status of ['active', 'inactive']) {
    const response = await getRequest(`/v2/options/contracts?${query}&status=${status}`);
    if (!response?.ok) continue;
    const contracts = response.data?.option_contracts ?? [];
    const contract = contracts.find((item) => item.symbol === symbol);
    const size = num(contract?.multiplier ?? contract?.size);
    if (contract && size !== null && size > 0) return { contractSize: size, source: 'alpaca_contract_metadata', status: contract.status ?? status };
  }
  return null;
}

const reconcile = createBrokerReconciler();
export const tools = [{
  name: 'broker_reconcile',
  description: 'Read-only comparison of V5 PAPER continuity and ledger state with the bound PAPER broker orders, fills, and positions.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => reconcile(),
}, {
  name: 'broker_trade_evidence',
  description: 'Join one local PAPER ledger trade to broker execution IDs, order/client IDs and retained trace decisions. Bounded evidence only; never a trading gate.',
  inputSchema: { type: 'object', properties: {
    tradeId: { type: 'string', minLength: 1, maxLength: 200 },
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    file: { type: 'string', minLength: 1, maxLength: 200 },
    offset: { type: 'integer', minimum: 0, maximum: 1000000 },
  }, required: ['tradeId'], additionalProperties: false },
  handler: async ({ tradeId, date, file, offset }) => {
    const mode = 'paper';
    const [broker, local] = await Promise.all([brokerSnapshot(), localSnapshot('paper')]);
    const historyEvents = [];
    const historyCoverage = [];
    const historyNames = ['signal_accepted_for_selection', 'contract_candidate', 'entry_construction', 'entry_set', 'buy_submit', 'buy_response', 'buy_reprice', 'buy_api_error', 'buy_cancel_request', 'entry_fill_link', 'position_quote_accepted', 'lot_decision', 'sell_latch', 'sell_request', 'position_exit'];
    const readHistory = async (filters) => {
      const result = await readLocalHistory({ mode: 'paper', date, file, limit: 200, eventNames: historyNames, ...filters });
      historyCoverage.push({ scope: Object.keys(filters)[0] ?? 'date', status: result.status, provenance: result.provenance,
        filesScanned: result.filesScanned, returned: result.returned, truncated: result.truncated,
        scanTruncated: result.scanTruncated, nextOffset: result.nextOffset });
      historyEvents.push(...(result.sessions ?? []).flatMap((session) => (session.events ?? []).map((event) => ({ ...event, runId: session.runId, wallTimeMs: Date.parse(event.at) }))));
      return result;
    };
    if (date) {
      const exactTradeHistory = await readHistory({ tradeId, offset });
      const entryEvent = historyEvents.find((row) => row.event === 'entry_fill_link' && row.fields?.tradeId === tradeId);
      if (entryEvent?.fields?.entrySetId || entryEvent?.fields?.tradeSetId) await readHistory({ tradeSetId: entryEvent.fields.tradeSetId ?? entryEvent.fields.entrySetId, offset: 0 });
      if (entryEvent?.runId) await readHistory({ runId: entryEvent.runId, offset: 0 });
      if (exactTradeHistory.status !== 'available') historyCoverage[0].status = exactTradeHistory.status;
    }
    const accountMatched = broker.mode === mode && local.mode === mode && local.accountHash
      && matchedAccountHash(broker.account?.data) === local.accountHash;
    const traceRows = [...telemetryRows(local), ...historyEvents];
    const trace = [...new Map(traceRows.map((row) => [`${row.runId}:${row.sequence ?? `${row.event}:${row.wallTimeMs}:${row.fields?.tradeId ?? ''}`}`, row])).values()];
    const symbol = ledgerRows(local?.ledger?.events ?? []).find((row) => row.tradeId === tradeId)?.symbol;
    const contractSize = accountMatched && symbol ? await readContractSize(symbol).catch(() => null) : null;
    const evidenceBroker = contractSize ? { ...broker, contractMetadata: { [symbol]: contractSize } } : broker;
    const allLinks = accountMatched ? executionLinks(local, evidenceBroker, trace) : [];
    const requestedSetId = allLinks.find((item) => item.tradeId === tradeId)?.tradeSetId;
    const setLinks = allLinks.filter((row) => requestedSetId && row.tradeSetId === requestedSetId);
    const setEntries = setLinks.filter((row) => row.ledgerEvent === 'FILL');
    const setExits = setLinks.filter((row) => row.ledgerEvent === 'EXIT');
    const realizedToDateKnown = setExits.length > 0 && setExits.every((row) => row.realizedPnlUsd !== null);
    const entryQuantity = setEntries.length && setEntries.every((row) => row.localLotQuantity !== null)
      ? setEntries.reduce((sum, row) => sum + row.localLotQuantity, 0) : null;
    const exitQuantity = setExits.length && setExits.every((row) => row.localLotQuantity !== null)
      ? setExits.reduce((sum, row) => sum + row.localLotQuantity, 0) : 0;
    const activeLots = local.continuity?.status === 'available'
      ? local.continuity.trades.filter((row) => row.tradeSetId === requestedSetId) : null;
    const remainingQuantity = activeLots ? activeLots.reduce((sum, row) => sum + (num(row.remainingQty) ?? 0), 0) : null;
    const setComplete = Boolean(requestedSetId && setEntries.length && setEntries.every((row) => row.match === 'execution_id_symbol_side')
      && setExits.length && setExits.every((row) => row.match === 'execution_id_symbol_side' && row.realizedPnlUsd !== null)
      && local.ledger?.status === 'available' && !local.ledger.truncated && !broker.fillsMayBeTruncated
      && remainingQuantity === 0 && entryQuantity !== null && entryQuantity === exitQuantity);
    return redact({ mode, capturedAt: broker.capturedAt, accountHash: local.accountHash,
      authority: { execution: 'broker', decisions: 'local_telemetry', monitoring: 'non_authoritative' },
      accountMatched: Boolean(accountMatched),
      links: allLinks.filter((row) => row.tradeId === tradeId),
      tradeSet: { tradeSetId: requestedSetId ?? null, entryFillCount: setEntries.length, exitFillCount: setExits.length,
        entryQuantity, exitQuantity, remainingQuantity, complete: setComplete,
        realizedPnlToDateUsd: realizedToDateKnown ? Math.round(setExits.reduce((sum, row) => sum + row.realizedPnlUsd, 0) * 100) / 100 : null,
        pnlStatus: realizedToDateKnown ? 'exact_execution_linked_realized_to_date' : 'unknown_missing_exact_fill_or_multiplier_evidence',
        fills: setLinks },
      coverage: { ledgerStatus: local.ledger?.status, ledgerTruncated: local.ledger?.truncated,
        brokerFillsMayBeTruncated: broker.fillsMayBeTruncated, brokerOrdersMayBeTruncated: broker.orderHistoryMayBeTruncated,
        history: historyCoverage },
      limitations: ['Only exact execution IDs with matching symbol and side establish links.', 'Absent links in bounded evidence remain unknown.', 'Historical traces do not establish current active state.'],
    });
  },
}];
