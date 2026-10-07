const ET = 'America/New_York';
const OPENING_RANGE_MS = 15 * 60_000;
const ENTRY_END_MINUTE_ET = 11 * 60 + 30;

const sourceTime = (value, name) => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${name} must be a timestamp`);
    return { ms: value, key: BigInt(Math.trunc(value)) * 1_000_000n };
  }
  if (typeof value !== 'string') throw new TypeError(`${name} must be a millisecond value or ISO timestamp`);
  const match = value.match(/^(.*?)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/);
  if (!match) throw new TypeError(`${name} must be a millisecond value or ISO timestamp`);
  const fraction = (match[2] ?? '').padEnd(9, '0').slice(0, 9);
  const milliseconds = Date.parse(`${match[1]}${fraction ? `.${fraction.slice(0, 3)}` : ''}${match[3]}`);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${name} must be a millisecond value or ISO timestamp`);
  const millisecondFraction = fraction ? fraction.slice(0, 3) : '';
  return { ms: milliseconds, key: BigInt(milliseconds) * 1_000_000n + BigInt(fraction || 0) - BigInt(millisecondFraction || 0) * 1_000_000n };
};

const asMs = (value, name) => {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`${name} must be a millisecond value or ISO timestamp`);
  return ms;
};

const localDate = (ms) => new Intl.DateTimeFormat('en-CA', {
  timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(ms));

const localMinutes = (ms) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  return Number(parts.find(({ type }) => type === 'hour').value) % 24 * 60 + Number(parts.find(({ type }) => type === 'minute').value);
};

export function createSignal({ onBreakout } = {}) {
  if (typeof onBreakout !== 'function') throw new TypeError('onBreakout must be a function');
  let session = null;
  let resetAt = null;
  let statusEvents = [];
  let trades = [];
  let latestSourceKey = null;
  let receiptSequence = 0;

  const reset = (nowMs) => {
    resetAt = asMs(nowMs, 'nowMs');
    trades = [];
    latestSourceKey = null;
    receiptSequence = 0;
  };

  const setSession = ({ date, open, close }) => {
    const openMs = asMs(open, 'session.open');
    const closeMs = asMs(close, 'session.close');
    if (!(closeMs > openMs)) throw new RangeError('session.close must be after session.open');
    session = { date, openMs, closeMs, rangeEndMs: openMs + OPENING_RANGE_MS };
    trades = [];
    latestSourceKey = null;
    receiptSequence = 0;
  };

  const onMarketDataStatus = ({ status, timestamp }) => {
    const at = asMs(timestamp, 'status.timestamp');
    if (status === 'subscription_confirmed' || status === 'reconnected') statusEvents.push({ at, ready: true });
    else if (status === 'disconnected' || status === 'reconnecting') statusEvents.push({ at, ready: false });
    return { ready: readyAt(at) };
  };

  const statusAt = (at) => statusEvents.filter((event) => event.at <= at).sort((a, b) => a.at - b.at).at(-1);
  const readyAt = (at) => statusAt(at)?.ready === true;
  const openingRangeCovered = () => Boolean(session && resetAt !== null && resetAt <= session.openMs &&
    readyAt(session.openMs) && !statusEvents.some((event) => !event.ready && event.at >= session.openMs && event.at < session.rangeEndMs));

  const onTrade = ({ timestamp, price, tradeId, exchange }, nowMs) => {
    const now = asMs(nowMs, 'nowMs');
    const parsed = sourceTime(timestamp, 'trade.timestamp');
    if (!Number.isFinite(price) || price <= 0) throw new TypeError('trade.price must be positive');
    if (latestSourceKey !== null && parsed.key < latestSourceKey) return { accepted: false, reason: 'late' };
    if (!session || now < session.openMs || now >= session.closeMs || parsed.ms < session.openMs || parsed.ms >= session.closeMs) return { accepted: false, reason: 'outside-session' };
    if (session.date && (localDate(now) !== session.date || localDate(parsed.ms) !== session.date)) return { accepted: false, reason: 'outside-session' };
    if (localMinutes(now) >= ENTRY_END_MINUTE_ET || localMinutes(parsed.ms) >= ENTRY_END_MINUTE_ET) return { accepted: false, reason: 'entry-cutoff' };

    const receipt = receiptSequence++;
    if (parsed.ms < session.rangeEndMs) {
      trades.push({ timestamp, ms: parsed.ms, key: parsed.key, price, tradeId, exchange, receipt });
    }
    if (latestSourceKey === null || parsed.key > latestSourceKey) latestSourceKey = parsed.key;
    if (parsed.ms < session.rangeEndMs || now < session.rangeEndMs) return { accepted: true };
    if (!openingRangeCovered() || !readyAt(now)) return { accepted: false, reason: 'opening-range-coverage' };

    const high = trades.reduce((value, trade) => Math.max(value, trade.price), -Infinity);
    const low = trades.reduce((value, trade) => Math.min(value, trade.price), Infinity);
    if (high === -Infinity || low === Infinity || high < low) return { accepted: false, reason: 'opening-range-invalid' };
    const margin = Math.max(0.05, 0.10 * (high - low));
    const direction = price >= high + margin ? 'CALL' : price <= low - margin ? 'PUT' : null;
    if (direction) onBreakout({ direction, timestamp, spyPrice: price, sourceTradeId: tradeId, receivedAt: now, priorHigh: high, priorLow: low, priorCount: trades.length, openingRangeHigh: high, openingRangeLow: low, openingRangeCount: trades.length,
      excessCents: Math.round((direction === 'CALL' ? price - high : low - price) * 10000) / 100,
      rangeCents: Math.round((high - low) * 10000) / 100, marginCents: Math.round(margin * 10000) / 100 });
    return { accepted: true };
  };

  const replaceTrade = ({ originalTradeId, exchange, correctedTrade }) => {
    const index = trades.findIndex((trade) => trade.tradeId === originalTradeId && (exchange == null || trade.exchange === exchange));
    if (index < 0) return { updated: false, reason: 'expired-or-unknown' };
    if (!correctedTrade || !Number.isFinite(correctedTrade.price) || correctedTrade.price <= 0) {
      trades.splice(index, 1);
      return { updated: true, removed: true };
    }
    const current = trades[index];
    const correctedTime = sourceTime(correctedTrade.timestamp ?? current.timestamp, 'correctedTrade.timestamp');
    if (correctedTime.ms < session.openMs || correctedTime.ms >= session.rangeEndMs) {
      trades.splice(index, 1);
      return { updated: true, removed: true };
    }
    trades[index] = { ...current, ...correctedTrade, timestamp: correctedTrade.timestamp ?? current.timestamp, key: correctedTime.key,
      tradeId: correctedTrade.tradeId ?? current.tradeId, exchange: correctedTrade.exchange ?? current.exchange, receipt: receiptSequence++ };
    return { updated: true, removed: false };
  };

  const removeTrade = ({ tradeId, exchange }) => {
    const before = trades.length;
    trades = trades.filter((trade) => !(trade.tradeId === tradeId && (exchange == null || trade.exchange === exchange)));
    return { removed: trades.length !== before };
  };

  const canEnter = (nowMs) => {
    const now = asMs(nowMs, 'nowMs');
    return Boolean(session && trades.length && openingRangeCovered() && readyAt(now) && now >= session.rangeEndMs && now < session.closeMs &&
      localMinutes(now) < ENTRY_END_MINUTE_ET && (!session.date || localDate(now) === session.date));
  };

  return { reset, onTrade, onCorrection: replaceTrade, onCancel: removeTrade, setSession, onMarketDataStatus, canEnter };
}
