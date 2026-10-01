import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const fields = ['tradeId', 'executionId', 'symbol', 'entryPrice', 'contractSize', 'contractSizeSource', 'fillTimestampMs', 'anchorBid', 'anchorSetAtMs', 'anchorSourceTimestamp', 'remainingQty', 'profitFloor', 'sellLatched', 'logicalSellId', 'orderId', 'signalId', 'tradeSetId'];
const validNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function validTrade(value) {
  const entry = Number(value?.entryPrice);
  const floor = value?.profitFloor === null ? null : Number(value?.profitFloor);
  const anchor = value?.anchorBid == null ? null : Number(value.anchorBid);
  const recovery = String(value?.tradeId ?? '').startsWith('recovery:');
  const exactCents = (number) => Number.isInteger(number * 100) || Math.abs(number * 100 - Math.round(number * 100)) < 1e-9;
  // Keep the raw quote anchor as provenance, while validating protection
  // against the higher of entry and anchor. Recovery trades have no entry.
  const floorBasis = Number.isFinite(entry) ? Math.max(entry, anchor ?? -Infinity) : anchor;
  const floorDelta = floor === null || !Number.isFinite(floorBasis) ? null : Math.round(floor * 100) - Math.round(floorBasis * 100);
  const anchorOk = value.anchorBid === undefined || value.anchorBid === null || (validNumber(value.anchorBid) && anchor > 0 && exactCents(anchor));
  const floorOk = floor === null || (anchor !== null && exactCents(floor) && exactCents(floorBasis) && floorDelta >= -2);
  const optionalId = (key) => value?.[key] === undefined || value?.[key] === null || (typeof value?.[key] === 'string' && value[key]);
  const anchorTimeOk = value?.anchorSetAtMs === undefined || value?.anchorSetAtMs === null || validNumber(value.anchorSetAtMs);
  const sizeOk = value?.contractSize === undefined || value?.contractSize === null || (validNumber(value.contractSize) && value.contractSize > 0);
  return value && typeof value === 'object' && typeof value.tradeId === 'string' && value.tradeId &&
    typeof value.executionId === 'string' && value.executionId && typeof value.symbol === 'string' && value.symbol &&
    ((recovery && value.entryPrice === null) || (validNumber(value.entryPrice) && entry > 0 && exactCents(entry))) && validNumber(value.remainingQty) && value.remainingQty > 0 &&
    (value.fillTimestampMs === undefined || validNumber(value.fillTimestampMs)) && anchorTimeOk && sizeOk && optionalId('signalId') && optionalId('tradeSetId') && optionalId('contractSizeSource') && anchorOk &&
    (value.profitFloor === null || validNumber(value.profitFloor)) && floorOk && typeof value.sellLatched === 'boolean' &&
    (value.logicalSellId === null || (typeof value.logicalSellId === 'string' && value.logicalSellId)) &&
    (value.orderId === null || (typeof value.orderId === 'string' && value.orderId)) &&
    (value.sellLatched ? Boolean(value.logicalSellId) : value.logicalSellId === null && value.orderId === null) && (!recovery || (value.sellLatched && value.profitFloor === null && anchor === null));
}

const pick = (trade) => {
  const picked = Object.fromEntries(fields.map((field) => [field, trade[field] ?? null]));
  if (!Number.isFinite(trade.fillTimestampMs)) delete picked.fillTimestampMs;
  return picked;
};

export function createContinuity({ path = 'state/v5-active-state.json', fs = {} } = {}) {
  const io = { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, ...fs };
  const clear = () => { if (io.existsSync(path)) io.unlinkSync(path); };
  const validPause = (pause) => pause === null || (pause && typeof pause === 'object' &&
    typeof pause.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(pause.date) && validNumber(pause.until));
  const validDailyLoss = (value) => value === null || (value && typeof value === 'object' &&
    typeof value.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.date) &&
    validNumber(value.dayStartEquity) && value.dayStartEquity > 0 &&
    validNumber(value.cumulativeRealizedGross) && (value.peakRealizedGross === undefined || (validNumber(value.peakRealizedGross) && value.peakRealizedGross >= 0)) && typeof value.tripped === 'boolean' &&
    Array.isArray(value.completedBuyIds) && value.completedBuyIds.every((id) => typeof id === 'string' && id.length > 0) &&
    new Set(value.completedBuyIds).size === value.completedBuyIds.length);
  const validSet = (set) => set && typeof set === 'object' && typeof set.tradeSetId === 'string' && set.tradeSetId &&
    typeof set.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(set.date) && typeof set.known === 'boolean' &&
    validNumber(set.entryQty) && set.entryQty >= 0 && validNumber(set.entryCentQty) && set.entryCentQty >= 0 &&
    validNumber(set.exitQty) && set.exitQty >= 0 && validNumber(set.exitCentQty) && set.exitCentQty >= 0 &&
    typeof set.entryTerminal === 'boolean' && (set.closedAt === null || validNumber(set.closedAt));
  const currentMetadata = () => {
    if (!io.existsSync(path)) return { pause: null, sets: [], dailyLoss: null };
    try {
      const parsed = JSON.parse(io.readFileSync(path, 'utf8'));
      return { pause: validPause(parsed?.pause) ? parsed.pause : null, sets: Array.isArray(parsed?.sets) && parsed.sets.every(validSet) ? parsed.sets : [], dailyLoss: validDailyLoss(parsed?.dailyLoss) ? parsed.dailyLoss : null };
    } catch { return { pause: null, sets: [], dailyLoss: null }; }
  };
  const save = (trades, metadata = {}) => {
    const active = trades.filter((trade) => Number(trade?.remainingQty) > 0);
    const invalid = active.filter((trade) => !String(trade?.tradeId ?? '').startsWith('recovery:') && !validTrade(trade));
    if (invalid.length) throw new TypeError('invalid active continuity state');
    const records = active.filter(validTrade).map(pick);
    const prior = currentMetadata();
    const pause = metadata.pause === undefined ? prior.pause : metadata.pause;
    const sets = metadata.sets === undefined ? prior.sets : metadata.sets;
    const dailyLoss = metadata.dailyLoss === undefined ? prior.dailyLoss : metadata.dailyLoss;
    if (!validPause(pause) || !Array.isArray(sets) || !sets.every(validSet) || new Set(sets.map((set) => set.tradeSetId)).size !== sets.length || !validDailyLoss(dailyLoss)) throw new TypeError('invalid runtime continuity state');
    if (!records.length && !pause && !sets.length && !dailyLoss) return clear();
    const directory = dirname(path);
    io.mkdirSync(directory, { recursive: true });
    const temporary = `${path}.tmp`;
    io.writeFileSync(temporary, `${JSON.stringify({ version: 1, trades: records, ...(pause ? { pause } : {}), ...(sets.length ? { sets } : {}), ...(dailyLoss ? { dailyLoss } : {}) })}\n`, { encoding: 'utf8', mode: 0o600 });
    io.renameSync(temporary, path);
  };
  const load = () => {
    if (!io.existsSync(path)) return { status: 'missing', trades: [] };
    try {
      const parsed = JSON.parse(io.readFileSync(path, 'utf8'));
      const logicalIds = parsed?.trades?.filter((trade) => trade.logicalSellId !== null).map((trade) => trade.logicalSellId) ?? [];
      const orderIds = parsed?.trades?.filter((trade) => trade.orderId !== null).map((trade) => trade.orderId) ?? [];
      const pause = parsed?.pause === undefined ? null : parsed.pause;
      const sets = parsed?.sets === undefined ? [] : parsed.sets;
      const dailyLoss = parsed?.dailyLoss === undefined ? null : parsed.dailyLoss;
      if (parsed?.version !== 1 || !Array.isArray(parsed.trades) || !parsed.trades.every(validTrade) || new Set(parsed.trades.map((trade) => trade.tradeId)).size !== parsed.trades.length || new Set(logicalIds).size !== logicalIds.length || new Set(orderIds).size !== orderIds.length || !validPause(pause) || !Array.isArray(sets) || !sets.every(validSet) || new Set(sets.map((set) => set.tradeSetId)).size !== sets.length || !validDailyLoss(dailyLoss)) return { status: 'incompatible', trades: [], pause: null, sets: [], dailyLoss: null };
      return { status: 'compatible', trades: parsed.trades.map(pick), pause, sets, dailyLoss };
    } catch { return { status: 'corrupt', trades: [], pause: null, sets: [], dailyLoss: null }; }
  };
  return { path, save, load, clear };
}

export function reconcileContinuity(snapshot, loaded) {
  const positions = new Map();
  for (const position of snapshot?.positions ?? []) {
    const symbol = position.symbol;
    const qty = Number(position.qty ?? position.quantity ?? 0);
    if (symbol && qty > 0) positions.set(symbol, (positions.get(symbol) ?? 0) + qty);
  }
  if (!positions.size) return { status: 'flat', trades: [] };
  if (loaded?.status !== 'compatible') return { status: 'recovery', trades: [] };
  const bySymbol = new Map();
  for (const trade of loaded.trades) bySymbol.set(trade.symbol, (bySymbol.get(trade.symbol) ?? 0) + Number(trade.remainingQty));
  if (positions.size !== bySymbol.size || [...positions].some(([symbol, qty]) => bySymbol.get(symbol) !== qty)) return { status: 'recovery', trades: [] };
  const openOrders = (snapshot.orders ?? []).filter((order) => positions.has(order.symbol));
  const openStatuses = ['new', 'accepted', 'pending_new', 'partially_filled', 'pending_replace', 'pending_cancel'];
  for (const order of openOrders) {
    if (order.side !== 'sell' || !openStatuses.includes(order.status)) continue;
    const linked = loaded.trades.some((trade) => trade.symbol === order.symbol && trade.sellLatched && (trade.orderId === order.id || trade.logicalSellId === order.clientOrderId || trade.logicalSellId === order.client_order_id));
    if (!linked) return { status: 'recovery', trades: [] };
  }
  const trades = loaded.trades.map((trade) => {
    const order = openOrders.find((candidate) => candidate.side === 'sell' && candidate.symbol === trade.symbol && (candidate.id === trade.orderId || candidate.clientOrderId === trade.logicalSellId || candidate.client_order_id === trade.logicalSellId));
    if (order && Number.isFinite(Number(order.qty)) && Number(order.qty) - Number(order.filled_qty ?? order.filledQty ?? 0) !== Number(trade.remainingQty)) return null;
    return { ...trade, orderId: order?.id ?? null };
  });
  if (trades.some((trade) => trade === null)) return { status: 'recovery', trades: [] };
  return { status: 'compatible', trades };
}
