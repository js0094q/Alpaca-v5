import { observe, createTrace } from './telemetry/trace.mjs';
import { createPostExitEvidence } from './telemetry/post-exit.mjs';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createAlpacaBroker } from './alpaca.mjs';
import { createAlpacaProviders } from './providers.mjs';
import { createRuntime } from './runtime.mjs';
import { createLedger } from './ledger.mjs';
import { createContinuity } from './continuity.mjs';
import { loadCloseoutCredentials } from './closeout.mjs';
import { PAPER_ENV, modeAccountPaths } from './paper-account.mjs';
import { acquireTradeAuthority, assertManualMarkerClear } from './trade-authority.mjs';

const DEFAULT_ENV = PAPER_ENV;
const DEFAULT_DURATION_MS = 10 * 60_000;
const DRAIN_POLL_MS = 1_000;
const isSpyOption = (symbol) => /^SPY\d{6}[CP]\d{8}$/.test(String(symbol));
const dateInET = (value) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(value));

const dispatch = (runtime, name, value) => {
  if (name === 'sip') runtime.onRawTrade(value);
  else if (name === 'opra') runtime.onQuote(value);
  else runtime.onOrderUpdate(value);
};

export const handleProviderStatus = (runtime, telemetry, value) => {
  observe(telemetry, 'provider_status', { stream: value.stream, status: value.status, attempt: value.attempt, frameType: value.frame?.T ?? value.frame?.stream, message: value.frame?.msg, authStatus: value.frame?.data?.status, subscribedTrades: value.frame?.trades?.length, subscribedQuotes: value.frame?.quotes?.length, listeningTradeUpdates: value.frame?.data?.streams?.includes('trade_updates'), code: value.frame?.code, errorName: value.error?.name });
  if (runtime && value.stream?.endsWith('/v2/sip') && ['disconnected', 'reconnected'].includes(value.status)) runtime.onMarketDataReconnect();
};

export async function runPaper({ mode, credentials: suppliedCredentials, durationMs = DEFAULT_DURATION_MS, untilClose = false, entryCutoffMinuteET = 15 * 60 + 30, stopAtMs = null, signal } = {}) {
  if (!['paper', 'live'].includes(mode)) throw new TypeError('mode must be paper or live');
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new TypeError('durationMs must be positive');
  if (!Number.isInteger(entryCutoffMinuteET) || entryCutoffMinuteET < 0 || entryCutoffMinuteET >= 24 * 60) throw new RangeError('entryCutoffMinuteET must be an integer minute of day');
  if (stopAtMs !== null && !Number.isFinite(stopAtMs)) throw new RangeError('stopAtMs must be a finite timestamp');
  if (!suppliedCredentials && mode !== 'paper') throw new Error('MODE_CREDENTIALS_REQUIRED');
  const credentials = suppliedCredentials ?? await loadCloseoutCredentials(DEFAULT_ENV);
  const baseUrl = mode === 'paper' ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
  let trace;
  let telemetry;
  let postExitEvidence;
  let releaseTradeAuthority;
  const emit = (event, fields) => {
    try { telemetry?.(event, fields); } catch {}
    try { postExitEvidence?.emit(event, fields); } catch {}
  };
  const broker = createAlpacaBroker({ key: credentials.key ?? credentials.apiKey, secret: credentials.secret ?? credentials.apiSecret, baseUrl, telemetry: emit });
  const providers = createAlpacaProviders({ key: credentials.key ?? credentials.apiKey, secret: credentials.secret ?? credentials.apiSecret, baseUrl, telemetry: emit });
  const pending = [];
  let runtime;
  let ready = false;
  const traceLedgerWrites = { persistedEntries: 0, persistedExits: 0, pending: 0, failures: 0 };
  let acceptingSip = true;
  let connection;
  const onMessage = (name, value) => {
    if (name === 'sip' && !acceptingSip) return;
    const receivedAtMs = name === 'opra' ? Date.now() : null;
    const receivedMonoMs = name === 'opra' ? performance.now() : null;
    if (ready) {
      dispatch(runtime, name, value);
      if (name === 'opra') { try { postExitEvidence?.quote(value, receivedAtMs, receivedMonoMs); } catch {} }
    } else pending.push([name, value, receivedAtMs, receivedMonoMs]);
  };

  const draining = async () => {
    acceptingSip = false;
    for (;;) {
      let snapshot;
      try {
        snapshot = await runtime.inspectCurrentOwnership();
      } catch (error) {
        observe(telemetry, 'drain_api_error', { errorName: error?.name, httpStatus: error?.httpStatus });
        await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
        continue;
      }
      const exposure = (snapshot.positions ?? []).some((position) => isSpyOption(position.symbol) && Number(position.qty ?? position.quantity ?? 0) !== 0);
      const pendingSell = (snapshot.orders ?? []).some((order) => order.side === 'sell' && isSpyOption(order.symbol));
      const entry = runtime.getState().entry;
      const buy = Boolean(entry?.active) || (snapshot.orders ?? []).some((order) => order.side === 'buy' && String(order.clientOrderId ?? order.client_order_id ?? '').startsWith('v5-buy-'));
      runtime.observeDrain(snapshot, !exposure && !pendingSell && !buy && !runtime.hasOwnership(), traceLedgerWrites);
      if (!exposure && !pendingSell && !buy && !runtime.hasOwnership()) return;
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
  };

  try {
    if (mode === 'paper') releaseTradeAuthority = await acquireTradeAuthority('v5-paper');
    const snapshot = await broker.inspectCurrentState();
    if (mode === 'paper') await assertManualMarkerClear(snapshot, { readOrder: (entry) => entry.clientOrderId ? broker.getOrderByClientOrderId(entry.clientOrderId) : broker.getOrder(entry.orderId) });
    const paths = modeAccountPaths(mode, snapshot.account);
    trace = createTrace({ directory: join(paths.directory, 'telemetry') });
    telemetry = trace.emit;
    try { postExitEvidence = createPostExitEvidence({ directory: join(paths.directory, 'post-exit-evidence') }); } catch {}
    connection = providers.connect({
      onRawTrade: (value) => onMessage('sip', value),
      onQuote: (value) => onMessage('opra', value),
      onTradeUpdate: (value) => onMessage('tradeUpdates', value),
      onStatus: (value) => handleProviderStatus(ready ? runtime : null, telemetry, value),
      onDisconnect: (value) => observe(telemetry, 'provider_disconnect', { stream: value.stream, code: value.event?.code }),
    });

    connection.subscribeOptions((snapshot.positions ?? []).map((position) => position.symbol).filter((symbol) => /^SPY\d{6}[CP]\d{8}$/.test(String(symbol))));

    const now = new Date();
    const start = dateInET(now);
    const end = dateInET(now.getTime() + 7 * 86_400_000);
    try { postExitEvidence?.emit('post_exit_context', { mode, accountHash: paths.accountHash, sessionDate: start }); } catch {}
    await providers.calendar.loadCalendar({ start, end });
    const session = untilClose ? providers.calendar.sessionFor(Date.now()) : null;
    const close = untilClose ? Date.parse(session?.close) : null;
    if (untilClose) {
      if (session?.status !== 'open' || !Number.isFinite(close) || close <= Date.now()) throw new Error('No remaining market session');
      durationMs = close - Date.now();
    }

    const getQuote = async (symbol) => {
      connection.subscribeOptions([symbol]);
      return providers.getQuote(symbol);
    };
    const ledger = createLedger({
      write: async (line, event) => {
        traceLedgerWrites.pending++;
        try {
          await mkdir(paths.directory, { recursive: true });
          await appendFile(paths.ledger, `${line}\n`);
          if (event?.event === 'FILL') traceLedgerWrites.persistedEntries++;
          if (event?.event === 'EXIT') traceLedgerWrites.persistedExits += Number(event.qty) || 0;
          observe(telemetry, 'ledger_write_success', { ledgerEvent: event?.event, summary: event?.summary, tradeId: event?.tradeId, executionId: event?.executionId, persistedEntries: traceLedgerWrites.persistedEntries, persistedExits: traceLedgerWrites.persistedExits });
        } catch (error) {
          traceLedgerWrites.failures++;
          observe(telemetry, 'ledger_write_failure', { ledgerEvent: event?.event, tradeId: event?.tradeId, executionId: event?.executionId, errorName: error?.name, errorCode: error?.code });
          throw error;
        } finally { traceLedgerWrites.pending--; }
      },
    });
    runtime = createRuntime({ broker, telemetry: emit, entryCutoffMinuteET, stopAtMs, getContracts: providers.getContracts, getQuote, calendar: providers.calendar, ledger: ledger.record, continuity: createContinuity({ path: paths.continuity }), dailyLossGuard: mode === 'paper', liquidateAt: untilClose ? close - 60_000 : null });
    await runtime.start();
    ready = true;
    for (const [name, value, receivedAtMs, receivedMonoMs] of pending.splice(0)) {
      dispatch(runtime, name, value);
      if (name === 'opra') { try { postExitEvidence?.quote(value, receivedAtMs, receivedMonoMs); } catch {} }
    }
    let finish;
    const stopped = new Promise((resolve) => { finish = resolve; });
    const onAbort = () => { runtime.stopEntries(); finish(); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    let timer;
    try {
      await Promise.race([new Promise((resolve) => { timer = setTimeout(resolve, untilClose ? Math.max(0, close - Date.now()) : stopAtMs !== null ? Math.max(0, stopAtMs - Date.now()) : durationMs); }), stopped]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    await draining();
    return { mode, runtime: runtime.getState(), durationMs, ...(untilClose ? { marketClose: close, liquidateAt: close - 60_000 } : {}) };
  } finally {
    ready = false;
    connection?.stop();
    runtime?.stop();
    if (postExitEvidence) {
      try {
        const status = postExitEvidence.status();
        observe(telemetry, 'post_exit_evidence_status', {
          enabled: status.enabled, failed: status.failed, failure: status.failure,
          emitted: status.emitted, written: status.written, dropped: status.dropped, truncated: status.truncated,
        });
      } catch {}
      try { postExitEvidence.stop(); } catch {}
    }
    trace?.stop();
    try { await releaseTradeAuthority?.(); } catch {}
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  runPaper({ mode, signal: controller.signal, untilClose: process.argv.includes('--until-close') }).then((report) => process.stdout.write(`${JSON.stringify(report)}\n`)).catch(() => {
    process.stdout.write('{"error":"BOT_RUN_FAILED"}\n');
    process.exitCode = 1;
  }).finally(() => { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); });
}
