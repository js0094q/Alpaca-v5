const WINDOW_MS = 30_000;
const WARMUP_MS = 30_000;
const ENTRY_DELAY_MS = 2 * 60_000;
const ENTRY_CUTOFF_MINUTE_ET = 15 * 60 + 30;
const ET = 'America/New_York';
const NS_PER_MS = 1_000_000n;
const WINDOW_NS = BigInt(WINDOW_MS) * NS_PER_MS;

const sourceTime = (value, name) => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${name} must be a timestamp`);
    return { ms: value, key: BigInt(Math.trunc(value)) * NS_PER_MS };
  }
  if (typeof value !== 'string') throw new TypeError(`${name} must be a millisecond value or ISO timestamp`);
  const match = value.match(/^(.*?)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/);
  if (!match) throw new TypeError(`${name} must be a millisecond value or ISO timestamp`);
  const fraction = (match[2] ?? '').padEnd(9, '0').slice(0, 9);
  const milliseconds = Date.parse(`${match[1]}${fraction ? `.${fraction.slice(0, 3)}` : ''}${match[3]}`);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${name} must be a millisecond value or ISO timestamp`);
  return { ms: milliseconds, key: BigInt(milliseconds) * NS_PER_MS + BigInt(fraction || 0) - BigInt(fraction ? fraction.slice(0, 3) : 0) * 1_000_000n };
};

const asMs = (value, name) => {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`${name} must be a millisecond value or ISO timestamp`);
  return ms;
};

const localDate = (ms) => new Intl.DateTimeFormat('en-CA', {
  timeZone: ET,
  year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(ms));

const localMinutes = (ms) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const hour = Number(parts.find(({ type }) => type === 'hour').value) % 24;
  return hour * 60 + Number(parts.find(({ type }) => type === 'minute').value);
};

export function createSignal({ onBreakout, entryCutoffMinuteET = ENTRY_CUTOFF_MINUTE_ET, breakoutMarginCents = 0, breakoutRangeFraction = 0 } = {}) {
  if (!Number.isInteger(entryCutoffMinuteET) || entryCutoffMinuteET < 0 || entryCutoffMinuteET >= 24 * 60) throw new RangeError('entryCutoffMinuteET must be an integer minute of day');
  if (!Number.isFinite(breakoutMarginCents) || breakoutMarginCents < 0) throw new RangeError('breakoutMarginCents must be a non-negative number');
  if (!Number.isFinite(breakoutRangeFraction) || breakoutRangeFraction < 0 || breakoutRangeFraction >= 1) throw new RangeError('breakoutRangeFraction must be in [0, 1)');
  if (typeof onBreakout !== 'function') throw new TypeError('onBreakout must be a function');
  const buyCutoffMinuteET = Math.min(entryCutoffMinuteET, 15 * 60 + 30);

  let warmupUntil = 0;
  let session = null;
  let trades = [];
  let latestSourceKey = null;
  let receiptSequence = 0;

  const reset = (nowMs) => {
    const now = asMs(nowMs, 'nowMs');
    warmupUntil = now + WARMUP_MS;
    trades = [];
    latestSourceKey = null;
    receiptSequence = 0;
  };

  const setSession = ({ date, open, close }) => {
    const openMs = asMs(open, 'session.open');
    const closeMs = asMs(close, 'session.close');
    if (!(closeMs > openMs)) throw new RangeError('session.close must be after session.open');
    session = { date, openMs, closeMs };
  };

  const prune = (nowKey) => {
    trades = trades.filter((trade) => trade.key > nowKey - WINDOW_NS);
  };

  const onTrade = ({ timestamp, price, tradeId, exchange, tape }, nowMs) => {
    const now = asMs(nowMs, 'nowMs');
    const parsed = sourceTime(timestamp, 'trade.timestamp');
    const tradeMs = parsed.ms;
    if (!Number.isFinite(price) || price <= 0) throw new TypeError('trade.price must be positive');
    if (latestSourceKey !== null && parsed.key < latestSourceKey) return { accepted: false, reason: 'late' };
    if (!session || now < session.openMs || now >= session.closeMs || tradeMs < session.openMs || tradeMs >= session.closeMs) {
      return { accepted: false, reason: 'outside-session' };
    }
    if (localMinutes(now) >= buyCutoffMinuteET || localMinutes(tradeMs) >= buyCutoffMinuteET || (session.date && (localDate(now) !== session.date || localDate(tradeMs) !== session.date))) {
      return { accepted: false, reason: 'entry-cutoff' };
    }

    const receipt = receiptSequence++;
    prune(parsed.key);
    const priorTrades = trades.filter((trade) => trade.key < parsed.key || (trade.key === parsed.key && trade.receipt < receipt));
    const high = priorTrades.reduce((value, trade) => Math.max(value, trade.price), -Infinity);
    const low = priorTrades.reduce((value, trade) => Math.min(value, trade.price), Infinity);
    const hasPriorTrade = priorTrades.length > 0;
    trades.push({ timestamp, ms: tradeMs, key: parsed.key, price, tradeId, exchange, tape, receipt });
    if (latestSourceKey === null || parsed.key > latestSourceKey) latestSourceKey = parsed.key;

    // Breakout must clear the 30s range by max(fixed cents, fraction of that range); both zero keeps the strict price > high rule.
    const margin = hasPriorTrade ? Math.max(breakoutMarginCents / 100, breakoutRangeFraction * (high - low)) : 0;
    const clears = (excess) => margin > 0 ? excess >= margin - 1e-9 : excess > 0;
    const direction = !hasPriorTrade ? null : clears(price - high) ? 'CALL' : clears(low - price) ? 'PUT' : null;
    if (now < warmupUntil || now < session.openMs + ENTRY_DELAY_MS || tradeMs < session.openMs + ENTRY_DELAY_MS) return { accepted: true };
    if (direction) onBreakout({ direction, timestamp, spyPrice: price, sourceTradeId: tradeId, receivedAt: now, priorHigh: high, priorLow: low, priorCount: priorTrades.length,
      excessCents: Math.round((direction === 'CALL' ? price - high : low - price) * 10_000) / 100, rangeCents: Math.round((high - low) * 10_000) / 100, marginCents: Math.round(margin * 10_000) / 100 });
    return { accepted: true };
  };

  const replaceTrade = ({ originalTradeId, exchange, correctedTrade }, nowMs) => {
    const now = sourceTime(nowMs, 'nowMs');
    prune(now.key);
    const index = trades.findIndex((trade) => trade.tradeId === originalTradeId && (exchange == null || trade.exchange === exchange));
    if (index < 0) return { updated: false, reason: 'expired-or-unknown' };
    const current = trades[index];
    if (!correctedTrade || !Number.isFinite(correctedTrade.price) || correctedTrade.price <= 0) {
      trades.splice(index, 1);
      return { updated: true, removed: true };
    }
    trades[index] = { ...current, ...correctedTrade, tradeId: correctedTrade.tradeId ?? current.tradeId, exchange: correctedTrade.exchange ?? current.exchange, receipt: receiptSequence++ };
    return { updated: true, removed: false };
  };

  const removeTrade = ({ tradeId, exchange }, nowMs) => {
    const now = sourceTime(nowMs, 'nowMs');
    prune(now.key);
    const before = trades.length;
    trades = trades.filter((trade) => !(trade.tradeId === tradeId && (exchange == null || trade.exchange === exchange)));
    return { removed: trades.length !== before };
  };

  return { reset, onTrade, onCorrection: replaceTrade, onCancel: removeTrade, setSession };
}
