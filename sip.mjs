// Alpaca SIP trade-condition rules for the price-forming high/low field of a minute bar.
// The signal layer still owns the 30-second range; this adapter only filters and routes tape events.
const RULES = new Map([
  [' ', { tapes: 'AB', highLow: true }], ['@', { tapes: 'CO', highLow: true }],
  ['A', { tapes: 'C', highLow: true }], ['B', { tapes: 'ABC', highLowByTape: { A: false, B: false, C: true } }],
  ['C', { tapes: 'ABCO', highLow: false }], ['D', { tapes: 'C', highLow: true }],
  ['E', { tapes: 'AB', highLow: true }], ['F', { tapes: 'ABC', highLow: true }],
  ['G', { tapes: 'C', highLow: false }], ['H', { tapes: 'ABC', highLow: false }],
  ['I', { tapes: 'ABCO', highLow: false }], ['K', { tapes: 'ABC', highLow: true }],
  ['L', { tapes: 'ABC', highLow: true }], ['M', { tapes: 'ABC', highLow: false }],
  ['N', { tapes: 'ABCO', highLow: false }], ['O', { tapes: 'ABC', highLow: true }],
  ['P', { tapes: 'ABCO', highLow: false }], ['Q', { tapes: 'ABC', highLow: false }],
  ['R', { tapes: 'ABCO', highLow: false }], ['T', { tapes: 'ABCO', highLow: true }],
  ['U', { tapes: 'ABCO', highLow: false }], ['V', { tapes: 'ABC', highLow: false }],
  ['W', { tapes: 'CO', highLow: false }], ['X', { tapes: 'ABC', highLow: true }],
  ['Y', { tapes: 'C', highLow: true }], ['Z', { tapes: 'ABC', highLow: false }],
  ['4', { tapes: 'ABC', highLow: false }], ['5', { tapes: 'ABC', highLow: true }],
  ['6', { tapes: 'ABC', highLow: true }], ['7', { tapes: 'ABC', highLow: false }],
  ['9', { tapes: 'ABC', highLow: false }],
]);

const identity = (trade) => `${trade.tape ?? ''}/${trade.exchange ?? ''}/${trade.tradeId ?? ''}`;
const isPriceForming = (rule, tape) => rule.highLowByTape ? rule.highLowByTape[tape] === true : rule.highLow === true;
const sourceKey = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? BigInt(Math.trunc(value)) * 1_000_000n : null;
  if (typeof value !== 'string') return null;
  const match = value.match(/^(.*?)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/);
  if (!match) return null;
  const fraction = (match[2] ?? '').padEnd(9, '0').slice(0, 9);
  const milliseconds = Date.parse(`${match[1]}${fraction ? `.${fraction.slice(0, 3)}` : ''}${match[3]}`);
  if (!Number.isFinite(milliseconds)) return null;
  return BigInt(milliseconds) * 1_000_000n + BigInt(fraction || 0) - BigInt(fraction ? fraction.slice(0, 3) : 0) * 1_000_000n;
};

export function tradeEligibility(trade) {
  if (!trade || trade.symbol !== 'SPY' || !['A', 'B', 'C', 'O'].includes(trade.tape)) return { eligible: false, reason: 'invalid-tape-or-symbol' };
  if (!Number.isFinite(trade.price) || trade.price <= 0 || typeof trade.timestamp !== 'string' || sourceKey(trade.timestamp) === null || trade.tradeId == null || typeof trade.exchange !== 'string') return { eligible: false, reason: 'invalid-trade' };
  if (!Array.isArray(trade.conditions) || trade.conditions.length === 0) return { eligible: false, reason: 'missing-conditions' };
  for (const condition of trade.conditions) {
    const rule = RULES.get(condition);
    if (!rule || !rule.tapes.includes(trade.tape) || !isPriceForming(rule, trade.tape)) return { eligible: false, reason: rule ? 'non-price-forming-condition' : 'unknown-condition' };
  }
  return { eligible: true };
}

export function createSipProcessor({ onTrade = () => {}, onCorrection = () => {}, onCancel = () => {} } = {}) {
  const active = new Map();

  const prune = (nowMs) => {
    const now = sourceKey(nowMs);
    if (now === null) return;
    for (const [key, trade] of active) {
      const timestamp = sourceKey(trade.timestamp);
      if (timestamp !== null && now - timestamp >= 30_000_000_000n) active.delete(key);
    }
  };

  const onRawTrade = (raw, nowMs = Date.now()) => {
    prune(nowMs);
    const frame = raw?.raw ?? raw;
    const type = raw?.rawType ?? frame?.T;
    if (type === 't') {
      const trade = raw?.symbol ? { ...raw, rawType: 't' } : { symbol: frame.S, price: Number(frame.p), timestamp: frame.t, conditions: frame.c ?? [], tradeId: frame.i, exchange: frame.x, tape: frame.z, rawType: 't', raw: frame };
      const eligibility = tradeEligibility(trade);
      if (!eligibility.eligible) return { accepted: false, reason: eligibility.reason };
      const key = identity(trade);
      if (active.has(key)) return { accepted: false, reason: 'duplicate' };
      active.set(key, trade);
      const result = onTrade(trade, nowMs);
      if (result?.accepted === false) { active.delete(key); return result; }
      return { accepted: true, result };
    }
    if (type === 'c') {
      const key = `${frame?.z ?? raw?.tape ?? ''}/${frame?.x ?? raw?.exchange ?? ''}/${frame?.oi ?? ''}`;
      const prior = active.get(key);
      if (!prior) return { updated: false, reason: 'expired-or-unknown' };
      active.delete(key);
      const corrected = { ...prior, tradeId: frame.ci, price: Number(frame.cp), conditions: frame.cc, timestamp: prior.timestamp, rawType: 't' };
      const result = tradeEligibility(corrected);
      if (!result.eligible) return { updated: true, removed: true, reason: result.reason, result: onCorrection({ originalTradeId: prior.tradeId, exchange: prior.exchange, correctedTrade: null }, nowMs) };
      active.set(identity(corrected), corrected);
      return { updated: true, result: onCorrection({ originalTradeId: prior.tradeId, exchange: prior.exchange, correctedTrade: corrected }, nowMs) };
    }
    if (type === 'x') {
      const key = `${frame?.z ?? raw?.tape ?? ''}/${frame?.x ?? raw?.exchange ?? ''}/${frame?.i ?? raw?.tradeId ?? ''}`;
      const prior = active.get(key);
      if (!prior) return { removed: false, reason: 'expired-or-unknown' };
      active.delete(key);
      return { removed: true, result: onCancel({ tradeId: prior.tradeId, exchange: prior.exchange }, nowMs) };
    }
    return { accepted: false, reason: 'unsupported-message' };
  };

  const reset = () => active.clear();
  return { onRawTrade, reset };
}

export { RULES };
