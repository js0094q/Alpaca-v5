import { randomUUID } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { createEvidenceWriter } from './evidence-writer.mjs';

const WINDOW_MS = 30_000;
const BOUNDARY_GRACE_MS = 1_000;
const MAX_ACTIVE_WINDOWS = 256;
const SAMPLE_INTERVAL_MS = 100;
const MAX_QUOTES_PER_WINDOW = 350;
const MAX_TRADE_LINKS = 4096;

export function createPostExitProcessor({ write, runId, nowMono = () => performance.now() }) {
  if (typeof write !== 'function') throw new TypeError('write is required');
  const context = { mode: null, accountHash: null, sessionDate: null };
  const entries = new Map();
  const windows = new Map();
  const seenExits = new Set();
  const orderTrades = new Map();
  let contextSet = false;
  let batchLoss = null;
  let previousDrops = 0;
  let previousTruncations = 0;
  let queuedInputs = 0;

  const rowFor = (window, event, wallTimeMs, fields = {}) => ({
    schema: 1, runId, windowId: window.windowId, event, wallTimeMs,
    fields: {
      mode: context.mode, accountHash: context.accountHash, sessionDate: context.sessionDate,
      tradeId: window.tradeId, tradeSetId: window.tradeSetId, entrySetId: window.entrySetId,
      signalId: window.signalId, actionSource: window.actionSource,
      orderId: window.entryOrderId, clientOrderId: window.entryClientOrderId,
      entryOrderId: window.entryOrderId, entryClientOrderId: window.entryClientOrderId,
      entryExecutionId: window.entryExecutionId, exitExecutionId: window.exitExecutionId,
      exitOrderId: window.exitOrderId, symbol: window.symbol,
      entryTimestamp: window.entryTimestamp, entryTimestampMs: window.entryTimestampMs,
      exitTimestamp: window.exitTimestamp, exitTimestampMs: window.exitTimestampMs, ...fields,
    },
  });
  const emit = (window, event, wallTimeMs, fields) => write(rowFor(window, event, wallTimeMs, fields));
  const remember = (map, key, value) => {
    if (!key) return;
    if (!map.has(key) && map.size >= MAX_TRADE_LINKS) map.delete(map.keys().next().value);
    map.set(key, value);
  };
  const markGap = async (window, reason, wallTimeMs, fields = {}) => {
    window.gapReason ||= reason;
    await emit(window, 'POST_EXIT_GAP', wallTimeMs, { reason, ...fields });
  };
  const close = async (window, status, wallTimeMs, extra = {}) => {
    if (!windows.delete(window.windowId)) return;
    if (window.quoteCount === 0) await markGap(window, 'no_post_exit_quotes', wallTimeMs);
    if (window.attributableQuoteCount === 0) await markGap(window, 'no_fresh_post_exit_quotes', wallTimeMs);
    if (!window.boundarySample) await markGap(window, 'boundary_quote_missing', wallTimeMs);
    const complete = status === 'elapsed' && window.identityComplete && window.attributableQuoteCount > 0 && window.boundarySample && !window.gapReason;
    await emit(window, 'POST_EXIT_END', wallTimeMs, {
      status: complete ? 'complete' : 'partial', elapsed: status === 'elapsed',
      coverage: 'sampled', quoteCount: window.quoteCount, attributableQuoteCount: window.attributableQuoteCount,
      boundarySample: window.boundarySample,
      postExitBidLow: window.observedBidLow,
      postExitBidHigh: window.observedBidHigh,
      favorableExcursionVsExitFill: window.observedBidHigh === null || window.exitPrice === null ? null : Math.round((window.observedBidHigh - window.exitPrice) * 1_000_000) / 1_000_000,
      adverseExcursionVsExitFill: window.observedBidLow === null || window.exitPrice === null ? null : Math.round((window.observedBidLow - window.exitPrice) * 1_000_000) / 1_000_000,
      ...extra,
    });
  };
  const expire = async (monoMs, wallTimeMs) => {
    for (const window of windows.values()) {
      if (monoMs >= window.boundaryDeadlineMonoMs) await close(window, 'elapsed', wallTimeMs);
    }
  };

  async function accept(row) {
    const event = row?.event;
    const fields = row?.fields ?? {};
    const wallTimeMs = Number.isFinite(row?.wallTimeMs) ? row.wallTimeMs : Date.now();
    const monoMs = Number.isFinite(row?.monoMs) ? row.monoMs : Number(nowMono());
    await expire(monoMs, wallTimeMs);

    if (event === 'post_exit_context') {
      if (contextSet) return;
      context.mode = fields.mode ?? null;
      context.accountHash = fields.accountHash ?? null;
      context.sessionDate = fields.sessionDate ?? null;
      contextSet = true;
      return;
    }
    if (event === 'entry_fill_link') {
      const prior = entries.get(fields.tradeId) ?? {};
      remember(entries, fields.tradeId, {
        ...prior, entrySetId: fields.entrySetId ?? prior.entrySetId ?? null,
        tradeSetId: fields.tradeSetId ?? fields.entrySetId ?? prior.tradeSetId ?? null,
        signalId: fields.signalId ?? prior.signalId ?? null,
        actionSource: fields.actionSource ?? prior.actionSource ?? null,
        entryOrderId: fields.orderId ?? prior.entryOrderId ?? null,
        entryClientOrderId: fields.clientOrderId ?? fields.entrySetId ?? prior.entryClientOrderId ?? null,
        entryExecutionId: fields.executionId ?? prior.entryExecutionId ?? null,
        entryPrice: fields.entryPrice ?? prior.entryPrice ?? null,
        entryQuantity: fields.quantity ?? prior.entryQuantity ?? null,
        symbol: fields.symbol ?? prior.symbol ?? null,
        entryTimestamp: typeof fields.brokerTimestamp === 'string' ? fields.brokerTimestamp : prior.entryTimestamp ?? null,
        entryTimestampMs: fillTimestampMs(fields.brokerTimestamp) ?? prior.entryTimestampMs ?? null,
      });
      return;
    }
    if (event === 'position_fill' || event === 'position_restored') {
      const prior = entries.get(fields.tradeId) ?? {};
      remember(entries, fields.tradeId, {
        ...prior, entryExecutionId: fields.executionId ?? prior.entryExecutionId ?? null,
        symbol: fields.symbol ?? prior.symbol ?? null,
        entryTimestamp: prior.entryTimestamp ?? null,
        entryTimestampMs: Number.isFinite(fields.fillTimestampMs) ? fields.fillTimestampMs : prior.entryTimestampMs ?? null,
      });
      return;
    }
    if (event === 'position_exit') {
      const entry = entries.get(fields.tradeId) ?? {};
      const exitExecutionId = fields.executionId ?? null;
      const exitKey = exitExecutionId ? `${fields.tradeId}:${exitExecutionId}` : null;
      if (exitKey && seenExits.has(exitKey)) return;
      if (exitKey) {
        if (seenExits.size >= MAX_TRADE_LINKS) seenExits.delete(seenExits.values().next().value);
        seenExits.add(exitKey);
      }
      const window = {
        windowId: randomUUID(), tradeId: fields.tradeId ?? null,
        entrySetId: entry.entrySetId ?? null,
        tradeSetId: entry.tradeSetId ?? entry.entrySetId ?? null,
        signalId: entry.signalId ?? fields.signalId ?? null,
        actionSource: fields.actionSource ?? entry.actionSource ?? null,
        entryOrderId: entry.entryOrderId ?? null,
        entryClientOrderId: entry.entryClientOrderId ?? entry.entrySetId ?? null,
        entryPrice: entry.entryPrice ?? null,
        entryQuantity: entry.entryQuantity ?? null,
        entryExecutionId: entry.entryExecutionId ?? null,
        exitExecutionId, symbol: fields.symbol ?? entry.symbol ?? null,
        entryTimestampMs: entry.entryTimestampMs ?? null,
        entryTimestamp: entry.entryTimestamp ?? null,
        exitTimestamp: typeof fields.brokerTimestamp === 'string' ? fields.brokerTimestamp : null,
        exitTimestampMs: fillTimestampMs(fields.brokerTimestamp),
        exitOrderId: orderTrades.get(fields.tradeId) ?? null,
        exitObservedAtMs: wallTimeMs, startMonoMs: monoMs, endMonoMs: monoMs + WINDOW_MS,
        boundaryDeadlineMonoMs: monoMs + WINDOW_MS + BOUNDARY_GRACE_MS,
        quoteCount: 0, attributableQuoteCount: 0, lastSourceTimestampMs: null,
        observedBidLow: null, observedBidHigh: null,
        exitPrice: fields.price !== null && fields.price !== undefined && fields.price !== '' && Number.isFinite(Number(fields.price)) ? Number(fields.price) : null,
        boundarySample: false, gapReason: null, lastSampleMonoMs: null, identityComplete: false,
      };
      const identityComplete = Boolean(exitExecutionId && window.symbol && fields.tradeId && entry.entrySetId && entry.entryExecutionId && entry.entryTimestampMs !== null && window.exitTimestampMs !== null);
      if (!exitExecutionId || !window.symbol || !fields.tradeId) {
        await emit(window, 'POST_EXIT_START', wallTimeMs, { windowMs: WINDOW_MS, identityComplete: false });
        await emit(window, 'POST_EXIT_GAP', wallTimeMs, { reason: !exitExecutionId ? 'missing_exit_execution_id' : 'missing_exit_identity' });
        await emit(window, 'POST_EXIT_END', wallTimeMs, { status: 'partial', quoteCount: 0 });
        return;
      }
      await emit(window, 'POST_EXIT_START', wallTimeMs, {
        windowMs: WINDOW_MS, sampleIntervalMs: SAMPLE_INTERVAL_MS,
        quantity: fields.quantity ?? null, exitPrice: fields.price ?? null,
        entryPrice: fields.entryPrice ?? window.entryPrice ?? null, entryQuantity: fields.entryQuantity ?? window.entryQuantity ?? null,
        profitFloor: fields.profitFloor ?? null, stopThreshold: fields.stopThreshold ?? null,
        identityComplete, coverage: 'sampled',
        exitObservedAtMs: wallTimeMs, exitObservedMonoMs: monoMs,
      });
      window.identityComplete = identityComplete;
      if (!identityComplete) window.gapReason = 'incomplete_trade_identity';
      if (batchLoss) window.gapReason ||= 'trace_queue_loss';
      if (windows.size >= MAX_ACTIVE_WINDOWS) {
        await emit(window, 'POST_EXIT_GAP', wallTimeMs, { reason: 'active_window_capacity', limit: MAX_ACTIVE_WINDOWS });
        await emit(window, 'POST_EXIT_END', wallTimeMs, { status: 'partial', quoteCount: 0 });
        return;
      }
      windows.set(window.windowId, window);
      if (window.gapReason) await markGap(window, window.gapReason, wallTimeMs);
      return;
    }
    if (event === 'post_exit_quote_input') {
      const receiptMonoMs = Number.isFinite(fields.receivedMonoMs) ? fields.receivedMonoMs : monoMs;
      await expire(receiptMonoMs, Number.isFinite(fields.receivedAtMs) ? fields.receivedAtMs : wallTimeMs);
      for (const window of windows.values()) {
        if (window.symbol !== fields.symbol || receiptMonoMs < window.startMonoMs || receiptMonoMs >= window.boundaryDeadlineMonoMs) continue;
        if (window.boundarySample) continue;
        if (window.quoteCount >= MAX_QUOTES_PER_WINDOW) {
          await markGap(window, 'quote_capacity', Number.isFinite(fields.receivedAtMs) ? fields.receivedAtMs : wallTimeMs, { limit: MAX_QUOTES_PER_WINDOW });
          continue;
        }
        const sourceTimestampMs = Number.isFinite(fields.sourceTimestampMs) ? fields.sourceTimestampMs : null;
        const sourceTimeOrder = sourceTimestampMs === null ? 'unknown'
          : window.lastSourceTimestampMs !== null && sourceTimestampMs < window.lastSourceTimestampMs ? 'out_of_order' : 'in_order';
        if (sourceTimestampMs !== null && (window.lastSourceTimestampMs === null || sourceTimestampMs > window.lastSourceTimestampMs)) window.lastSourceTimestampMs = sourceTimestampMs;
        const sourceBeforeExit = sourceTimestampMs !== null && window.exitTimestampMs !== null && sourceTimestampMs < window.exitTimestampMs;
        const usable = Number.isFinite(fields.bid) && fields.bid > 0 && Number.isFinite(fields.ask) && fields.ask >= fields.bid;
        const boundarySample = receiptMonoMs >= window.endMonoMs && sourceTimestampMs !== null &&
          window.exitTimestampMs !== null && sourceTimestampMs >= window.exitTimestampMs + WINDOW_MS && sourceTimeOrder === 'in_order' && usable;
        const sampledQuote = {
          bid: fields.bid, ask: fields.ask ?? null, sourceTimestamp: fields.sourceTimestamp ?? null,
          sourceTimestampMs, receivedAtMs: fields.receivedAtMs ?? wallTimeMs,
          receivedMonoMs: receiptMonoMs, sourceTimeOrder,
          sourceTimestampValid: sourceTimestampMs !== null,
          stale: sourceTimeOrder === 'out_of_order' || sourceBeforeExit || sourceTimestampMs === null,
          sourceBeforeExit, usable, boundarySample, stream: 'opra',
        };
        if (!boundarySample && window.lastSampleMonoMs !== null && receiptMonoMs - window.lastSampleMonoMs < SAMPLE_INTERVAL_MS) {
          continue;
        }
        window.quoteCount++;
        if (sourceTimeOrder === 'in_order' && !sourceBeforeExit && usable) window.attributableQuoteCount++;
        if (sourceTimeOrder === 'in_order' && !sourceBeforeExit && Number.isFinite(fields.bid) && fields.bid > 0) {
          window.observedBidLow = window.observedBidLow === null ? fields.bid : Math.min(window.observedBidLow, fields.bid);
          window.observedBidHigh = window.observedBidHigh === null ? fields.bid : Math.max(window.observedBidHigh, fields.bid);
        }
        if (boundarySample) window.boundarySample = true;
        window.lastSampleMonoMs = receiptMonoMs;
        await emit(window, 'POST_EXIT_QUOTE', sampledQuote.receivedAtMs, { ...sampledQuote, quoteIndex: window.quoteCount, coverage: 'sampled' });
        if (boundarySample) await close(window, 'elapsed', Number.isFinite(fields.receivedAtMs) ? fields.receivedAtMs : wallTimeMs);
      }
      return;
    }
    if (event === 'sell_order_update' && fields.orderId && fields.tradeId) remember(orderTrades, fields.tradeId, fields.orderId);
  }

  async function batch(rows, stats = {}) {
    const dropped = Number(stats.dropped) || 0;
    const truncated = Number(stats.truncated) || 0;
    const loss = dropped - previousDrops;
    const truncation = truncated - previousTruncations;
    previousDrops = dropped;
    previousTruncations = truncated;
    queuedInputs = Number(stats.queued) || 0;
    batchLoss = loss > 0 || truncation > 0 ? { dropped: Math.max(0, loss), truncated: Math.max(0, truncation) } : null;
    if (batchLoss) {
      for (const window of windows.values()) window.gapReason ||= 'trace_queue_loss';
      for (const window of windows.values()) await markGap(window, 'trace_queue_loss', Date.now(), batchLoss);
    }
    for (const row of rows) await accept(row);
    batchLoss = null;
  }

  async function tick() { if (queuedInputs === 0) await expire(Number(nowMono()), Date.now()); }

  async function stop(stats = {}) {
    await batch([], stats);
    await expire(Number(nowMono()), Date.now());
    for (const window of [...windows.values()]) await close(window, 'incomplete_shutdown', Date.now(), { remainingWindowMs: Math.max(0, window.endMonoMs - Number(nowMono())) });
  }

  return { accept, batch, tick, stop, status: () => ({ activeWindows: windows.size, linkedTrades: entries.size }) };
}

const parent = parentPort;
if (parent) {
  let writer;
  let processor;
  let failed = false;
  let timer;
  let work = Promise.resolve();
  let tickQueued = false;
  const fail = async (error) => {
    if (failed) return;
    failed = true;
    clearInterval(timer);
    parent.postMessage({ type: 'failure', code: error?.code === 'ENOSPC' ? 'ENOSPC' : 'WRITER_FAILED' });
    await writer?.close().catch(() => {});
    parent.close();
  };
  try {
    writer = await createEvidenceWriter({
      directory: workerData.directory, runId: workerData.runId,
      // One observed session was 155 MiB; 1 GiB retains several sessions at
      // that scale while whole-file 30-day expiry remains the age policy.
      retentionMs: 30 * 86_400_000, maxTotalBytes: 1024 * 1024 * 1024,
    });
    processor = createPostExitProcessor({ write: (row) => writer.write(row), runId: workerData.runId });
    parent.postMessage({ type: 'ready' });
    timer = setInterval(() => {
      if (tickQueued || failed) return;
      tickQueued = true;
      work = work.then(() => processor.tick()).catch(fail).finally(() => { tickQueued = false; });
    }, 100);
    timer.unref();
    parent.on('message', (message) => {
      work = work.then(async () => {
        if (failed) return;
        if (message.type === 'batch') {
          await processor.batch(message.rows, message.stats);
          parent.postMessage({ type: 'ack' });
        } else if (message.type === 'stop') {
          clearInterval(timer);
          await processor.stop(message.stats);
          await writer.close();
          parent.postMessage({ type: 'stopped' });
          parent.close();
        }
      }).catch(fail);
    });
  } catch (error) { await fail(error); }
}

function timestampMs(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fillTimestampMs(value) {
  const parsed = timestampMs(value);
  if (parsed === null || typeof value !== 'string') return parsed;
  const fraction = value.match(/\.(\d+)(?=Z|[+-]\d\d:?\d\d$)/)?.[1];
  const discarded = fraction?.slice(3);
  return discarded && /[1-9]/.test(discarded) ? parsed + 1 : parsed;
}
