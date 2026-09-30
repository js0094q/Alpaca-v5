import { createTrace } from './trace.mjs';

const WORKER_URL = new URL('./post-exit-worker.mjs', import.meta.url);
const OBSERVED_EVENTS = new Set([
  'post_exit_context', 'entry_fill_link', 'position_fill', 'position_restored',
  'position_exit', 'sell_order_update',
]);
const WINDOW_MS = 30_000;
const BOUNDARY_GRACE_MS = 1_000;
const SAMPLE_INTERVAL_MS = 100;
const MAX_ACTIVE_WINDOWS = 256;

const timestampMs = (value) => {
  if (Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const numeric = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function createPostExitEvidence({ directory, enabled = true } = {}) {
  const trace = createTrace({ directory, enabled, workerUrl: WORKER_URL, capacity: 2048 });
  // Keep high-rate OPRA noise out of trace's bounded queue. The worker applies
  // the same 100 ms sample cadence after dispatch; sampling here prevents the
  // raw feed from crowding lifecycle rows out before the worker can see them.
  const quoteWindows = new Map();
  const lastQuoteSample = new Map();
  const tradeSymbols = new Map();
  let nextWindowId = 0;
  const prune = (receivedMonoMs) => {
    for (const [id, window] of quoteWindows) {
      if (receivedMonoMs >= window.deadlineMonoMs) quoteWindows.delete(id);
    }
  };
  const rememberQuoteSample = (symbol, receivedMonoMs) => {
    lastQuoteSample.delete(symbol);
    lastQuoteSample.set(symbol, receivedMonoMs);
    if (lastQuoteSample.size > MAX_ACTIVE_WINDOWS) lastQuoteSample.delete(lastQuoteSample.keys().next().value);
  };
  return {
    emit(event, fields) {
      if (OBSERVED_EVENTS.has(event)) {
        const normalized = {};
        const source = fields ?? {};
        const keys = [...new Set(['signalId', 'tradeSetId', 'entrySetId', 'tradeId', 'actionSource', 'orderId', 'clientOrderId', ...Object.keys(source)])];
        for (const key of keys.slice(0, 33)) {
          if (!Object.hasOwn(source, key)) continue;
          const value = source[key];
          normalized[key] = value === undefined ? null : value;
        }
        if ((!normalized.symbol || typeof normalized.symbol !== 'string') && normalized.tradeId && tradeSymbols.has(normalized.tradeId)) {
          normalized.symbol = tradeSymbols.get(normalized.tradeId);
        }
        if (event === 'position_exit') prune(performance.now());
        const accepted = trace.emit(event, normalized);
        if (accepted && normalized.tradeId && typeof normalized.symbol === 'string' && normalized.symbol) {
          tradeSymbols.delete(normalized.tradeId);
          tradeSymbols.set(normalized.tradeId, normalized.symbol);
          if (tradeSymbols.size > MAX_ACTIVE_WINDOWS * 16) tradeSymbols.delete(tradeSymbols.keys().next().value);
        }
        if (accepted && event === 'position_exit' && typeof normalized.symbol === 'string' && normalized.symbol) {
          const exitMonoMs = performance.now();
          prune(exitMonoMs);
          const exitTimestampMs = timestampMs(normalized.brokerTimestamp);
          const key = normalized.tradeId && normalized.executionId
            ? `${normalized.tradeId}:${normalized.executionId}`
            : `local-${++nextWindowId}`;
          if (!quoteWindows.has(key) && quoteWindows.size < MAX_ACTIVE_WINDOWS) {
            quoteWindows.set(key, {
              symbol: normalized.symbol,
              startMonoMs: exitMonoMs,
              endMonoMs: exitMonoMs + WINDOW_MS,
              deadlineMonoMs: exitMonoMs + WINDOW_MS + BOUNDARY_GRACE_MS,
              exitTimestampMs,
              firstQuotePending: true,
            });
          }
        }
        return accepted;
      }
      return false;
    },
    quote(value, receivedAtMs = Date.now(), receivedMonoMs = performance.now()) {
      if (!value?.symbol) return false;
      const symbol = String(value.symbol);
      const receiptMonoMs = Number.isFinite(receivedMonoMs) ? receivedMonoMs : performance.now();
      prune(receiptMonoMs);
      const windows = [...quoteWindows.values()].filter((window) =>
        window.symbol === symbol && receiptMonoMs >= window.startMonoMs && receiptMonoMs < window.deadlineMonoMs);
      if (!windows.length) return false;
      const sourceTimestamp = typeof value.timestamp === 'string' ? value.timestamp : null;
      const sourceTimestampMs = timestampMs(value.timestamp);
      const bid = numeric(value.bid);
      const ask = numeric(value.ask);
      const usable = bid !== null && bid > 0 && ask !== null && ask >= bid;
      const firstQuote = windows.some((window) => window.firstQuotePending);
      // Preserve a quote at/after every logical window boundary even when it
      // arrives inside the ordinary 100 ms coalescing interval. The processor
      // still validates ordering, usability, and source-time attribution.
      const boundaryCandidate = usable && windows.some((window) => receiptMonoMs >= window.endMonoMs &&
        sourceTimestampMs !== null && window.exitTimestampMs !== null &&
        sourceTimestampMs >= window.exitTimestampMs + WINDOW_MS);
      const previousSample = lastQuoteSample.get(symbol);
      if (!firstQuote && !boundaryCandidate && previousSample !== undefined && receiptMonoMs - previousSample < SAMPLE_INTERVAL_MS) return false;
      const accepted = trace.emit('post_exit_quote_input', {
        symbol, bid, ask, sourceTimestamp,
        sourceTimestampMs, receivedAtMs, receivedMonoMs: receiptMonoMs,
      });
      if (accepted) {
        rememberQuoteSample(symbol, receiptMonoMs);
        for (const window of windows) window.firstQuotePending = false;
      }
      return accepted;
    },
    status: trace.status,
    stop: trace.stop,
  };
}
