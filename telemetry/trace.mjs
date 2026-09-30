import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function observe(emit, event, fields) {
  try { emit?.(event, fields); } catch {}
}

// Primitive-only bounded copy. No I/O, network, await, or JSON serialization on emit.
const CRITICAL_EVENTS = new Set([
  'entry_fill_link', 'entry_set', 'entry_state', 'entry_construction',
  'contract_candidate', 'signal_range', 'signal_accepted_for_selection',
  'trade_update_received', 'position_fill',
  'position_exit', 'sell_order_update', 'protection_arm_5c', 'protection_rearm_8c',
  'drain_reconciliation', 'post_exit_context', 'post_exit_evidence_status',
  'provider_disconnect', 'broker_api_error', 'provider_api_error', 'calendar_api_error', 'drain_api_error',
]);
const CRITICAL_DECISIONS = new Set(['LOSS_LATCH', 'ARM_5C', 'REARM_8C', 'PROFIT_FLOOR_LATCH', 'CEILING_10C']);

function isCriticalEvent(event) {
  return CRITICAL_EVENTS.has(event) || /^(buy_|sell_|ledger_|position_restored|ownership_|final_|runtime_state)/.test(event);
}

export function createTrace({ directory, enabled = true, capacity = 8192, batchSize = 512,
  flushMs = 50, shutdownMs = 3000, maxBytes = 64 * 1024 * 1024, maxSegments = 256,
  workerUrl = new URL('./writer.mjs', import.meta.url) } = {}) {
  const runId = randomUUID();
  const state = { runId, enabled: Boolean(enabled), ready: false, failed: false, stopped: false,
    emitted: 0, queued: 0, inFlight: 0, written: 0, dropped: 0, truncated: 0, failure: null };
  let worker, timer, deadline, stopping = false, next = 0, head = 0;
  let queue = [];
  const valid = Number.isInteger(capacity) && capacity > 0 && capacity <= 8192 &&
    Number.isInteger(batchSize) && batchSize > 0 && batchSize <= 512 &&
    Number.isFinite(flushMs) && flushMs >= 10 && flushMs <= 1000 &&
    Number.isFinite(shutdownMs) && shutdownMs >= 10 && shutdownMs <= 5000;
  const reserved = Math.min(512, Math.max(1, Math.floor(capacity / 8)));
  const finish = () => { clearInterval(timer); clearTimeout(deadline); state.stopped = true; state.ready = false; worker?.unref(); };
  const fail = (code) => {
    if (state.failed || state.stopped) return;
    state.failed = true; state.failure = code;
    state.dropped += state.queued + state.inFlight;
    state.queued = 0; state.inFlight = 0; queue = [];
    finish();
    try { worker?.terminate().catch(() => {}); } catch {}
  };
  const send = (message) => { try { worker.postMessage(message); return true; } catch { fail('POST_FAILED'); return false; } };
  const pump = () => {
    if (!state.ready || state.failed || state.stopped || state.inFlight) return;
    if (!state.queued) {
      if (stopping) { state.ready = false; send({ type: 'stop', stats: { ...state } }); }
      return;
    }
    const rows = [];
    while (state.queued && rows.length < batchSize) {
      rows.push(queue[head]); queue[head] = undefined; head = (head + 1) % capacity; state.queued--;
    }
    state.inFlight = rows.length;
    send({ type: 'batch', rows, stats: { emitted: state.emitted, dropped: state.dropped, truncated: state.truncated } });
  };
  const emit = (event, fields = {}) => {
    if (!state.enabled) return false;
    state.emitted++;
    let critical = typeof event === 'string' && isCriticalEvent(event);
    if (!critical && event === 'lot_decision') {
      try { critical = CRITICAL_DECISIONS.has(fields?.action); } catch {}
    }
    const limit = critical ? capacity : capacity - reserved;
    if (stopping || state.failed || state.stopped || state.queued >= limit) { state.dropped++; return false; }
    try {
      if (typeof event !== 'string' || !event || !fields || typeof fields !== 'object') { state.dropped++; return false; }
      const data = Object.create(null);
      let count = 0;
      for (const key in fields) {
        if (!Object.hasOwn(fields, key)) continue;
        if (count >= 32) { state.truncated++; break; }
        const value = fields[key];
        if (value === undefined) continue;
        if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) data[key.slice(0, 64)] = value;
        else if (typeof value === 'string') { data[key.slice(0, 64)] = value.slice(0, 256); if (value.length > 256) state.truncated++; }
        else { state.truncated++; continue; }
        count++;
      }
      queue[next] = { schema: 1, runId, sequence: state.emitted, wallTimeMs: Date.now(), monoMs: performance.now(), event: event.slice(0, 80), fields: data };
      next = (next + 1) % capacity; state.queued++;
      return true;
    } catch { state.dropped++; return false; }
  };
  const stop = () => {
    if (stopping || state.stopped) return;
    stopping = true;
    if (!state.enabled) { finish(); return; }
    // Shutdown may keep the event loop alive for at most shutdownMs; never waits on the caller.
    timer?.ref();
    deadline = setTimeout(() => fail('SHUTDOWN_TIMEOUT'), shutdownMs);
    deadline.unref(); pump();
  };
  if (!enabled) return { emit, status: () => ({ ...state }), stop };
  if (directory instanceof URL) { try { directory = fileURLToPath(directory); } catch { directory = null; } }
  if (!valid || typeof directory !== 'string' || !directory) { fail('INVALID_CONFIGURATION'); return { emit, status: () => ({ ...state }), stop }; }
  queue = new Array(capacity);
  try {
    worker = new Worker(workerUrl, { workerData: { directory, runId, maxBytes, maxSegments }, resourceLimits: { maxOldGenerationSizeMb: 32 } });
    worker.on('message', (message) => {
      if (state.stopped || state.failed) return;
      if (message.type === 'ready') { state.ready = true; pump(); }
      else if (message.type === 'ack') { state.written += state.inFlight; state.inFlight = 0; if (stopping) pump(); }
      else if (message.type === 'stopped') finish();
      else if (message.type === 'failure') fail(['ENOSPC', 'RETENTION_LIMIT'].includes(message.code) ? message.code : 'WRITER_FAILED');
    });
    worker.on('error', () => fail('WORKER_ERROR'));
    worker.on('exit', (code) => { if (!state.stopped) fail(`WORKER_EXIT_${code}`); });
    timer = setInterval(pump, flushMs); timer.unref(); worker.unref();
  } catch { fail('WORKER_START_FAILED'); }
  return { emit, status: () => ({ ...state }), stop };
}
