import { appendFile, mkdir } from 'node:fs/promises';
import { createAlpacaBroker } from './alpaca.mjs';
import { createAlpacaProviders } from './providers.mjs';
import { createRuntime } from './runtime.mjs';
import { join } from 'node:path';
import { createLedger } from './ledger.mjs';
import { createContinuity } from './continuity.mjs';
import { loadModeCredentials, assertLiveAccount, loadCloseoutCredentials, PAPER_ENV, modeAccountPaths } from './paper-account.mjs';
import { acquireTradeAuthority, assertLiveManualMarkerClear, assertManualMarkerClear } from './trade-authority.mjs';

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

export const handleProviderStatus = (runtime, value) => {
  if (runtime && value.stream?.endsWith('/v2/sip') && ['disconnected', 'reconnected'].includes(value.status)) runtime.onMarketDataReconnect();
};

export async function runPaper({ mode, credentials: suppliedCredentials, durationMs = DEFAULT_DURATION_MS, untilClose = false, entryCutoffMinuteET = 15 * 60 + 30, stopAtMs = null, flattenAtMs = null, signal, dependencies = {} } = {}) {
  if (!['paper', 'live'].includes(mode)) throw new TypeError('mode must be paper or live');
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new TypeError('durationMs must be positive');
  if (!Number.isInteger(entryCutoffMinuteET) || entryCutoffMinuteET < 0 || entryCutoffMinuteET >= 24 * 60) throw new RangeError('entryCutoffMinuteET must be an integer minute of day');
  if (stopAtMs !== null && !Number.isFinite(stopAtMs)) throw new RangeError('stopAtMs must be a finite timestamp');
  if (flattenAtMs !== null && (!Number.isFinite(flattenAtMs) || untilClose)) throw new RangeError('flattenAtMs must be a finite timestamp and cannot combine with untilClose');
  if (mode === 'live' && suppliedCredentials) throw Object.assign(new Error('LIVE_CREDENTIAL_OVERRIDE_FORBIDDEN'), { code: 'LIVE_CREDENTIAL_OVERRIDE_FORBIDDEN' });
  const credentials = mode === 'live'
    ? await (dependencies.loadModeCredentials ?? loadModeCredentials)(mode)
    : suppliedCredentials ?? await loadCloseoutCredentials(DEFAULT_ENV);
  const baseUrl = mode === 'paper' ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
  let releaseTradeAuthority;
  const broker = (dependencies.createBroker ?? createAlpacaBroker)({ key: credentials.key ?? credentials.apiKey, secret: credentials.secret ?? credentials.apiSecret, baseUrl });
  let providers;
  const pending = [];
  let runtime;
  let ready = false;
  let acceptingSip = true;
  let connection;
  const onMessage = (name, value) => {
    if (name === 'sip' && !acceptingSip) return;
    if (ready) {
      dispatch(runtime, name, value);
    } else pending.push([name, value]);
  };

  const draining = async () => {
    acceptingSip = false;
    for (;;) {
      let snapshot;
      try {
        snapshot = await runtime.inspectCurrentOwnership();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
        continue;
      }
      const exposure = (snapshot.positions ?? []).some((position) => isSpyOption(position.symbol) && Number(position.qty ?? position.quantity ?? 0) !== 0);
      const pendingSell = (snapshot.orders ?? []).some((order) => order.side === 'sell' && isSpyOption(order.symbol));
      const entry = runtime.getState().entry;
      const buy = Boolean(entry?.active) || (snapshot.orders ?? []).some((order) => order.side === 'buy' && String(order.clientOrderId ?? order.client_order_id ?? '').startsWith('v5-buy-'));
      if (!exposure && !pendingSell && !buy && !runtime.hasOwnership()) return;
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
  };

  try {
    releaseTradeAuthority = await (dependencies.acquireTradeAuthority ?? acquireTradeAuthority)(mode === 'paper' ? 'v5-paper' : 'v5-live');
    const snapshot = await broker.inspectCurrentState();
    if (mode === 'live') await (dependencies.assertLiveAccount ?? assertLiveAccount)(snapshot.account, { baseUrl });
    if (mode === 'paper') await assertManualMarkerClear(snapshot, { readOrder: (entry) => entry.clientOrderId ? broker.getOrderByClientOrderId(entry.clientOrderId) : broker.getOrder(entry.orderId) });
    else await (dependencies.assertLiveManualMarkerClear ?? assertLiveManualMarkerClear)();
    const paths = modeAccountPaths(mode, snapshot.account);
    providers = (dependencies.createProviders ?? createAlpacaProviders)({ key: credentials.key ?? credentials.apiKey, secret: credentials.secret ?? credentials.apiSecret, baseUrl });
    connection = providers.connect({
      onRawTrade: (value) => onMessage('sip', value),
      onQuote: (value) => onMessage('opra', value),
      onTradeUpdate: (value) => onMessage('tradeUpdates', value),
      onStatus: (value) => handleProviderStatus(ready ? runtime : null, value),
    });

    connection.subscribeOptions((snapshot.positions ?? []).map((position) => position.symbol).filter((symbol) => /^SPY\d{6}[CP]\d{8}$/.test(String(symbol))));

    const now = new Date();
    const start = dateInET(now);
    const end = dateInET(now.getTime() + 7 * 86_400_000);
    await providers.calendar.loadCalendar({ start, end });
    const session = untilClose || flattenAtMs !== null ? providers.calendar.sessionFor(Date.now()) : null;
    const close = untilClose || flattenAtMs !== null ? Date.parse(session?.close) : null;
    if (untilClose) {
      if (session?.status !== 'open' || !Number.isFinite(close) || close <= Date.now()) throw new Error('No remaining market session');
      durationMs = close - Date.now();
    }
    let liquidateAt = flattenAtMs;
    if (flattenAtMs !== null) {
      if (!Number.isFinite(close) || session?.date !== start) throw Object.assign(new Error('Cannot resolve the current trading session close for --flatten-at.'), { code: 'LIVE_FLATTEN_SESSION_UNKNOWN' });
      liquidateAt = Math.min(flattenAtMs, close - 60_000);
    }

    const getQuote = async (symbol) => {
      connection.subscribeOptions([symbol]);
      return providers.getQuote(symbol);
    };
    const ledger = createLedger({
      write: async (line) => {
        await mkdir(paths.directory, { recursive: true });
        await appendFile(paths.ledger, `${line}\n`);
      },
    });
    // ponytail: append-only per-ET-day jsonl of OPRA quotes + exit decisions; no retention policy, prune by hand if the account dir grows.
    const telemetry = (event) => { mkdir(paths.directory, { recursive: true }).then(() => appendFile(join(paths.directory, `telemetry-${dateInET(event.at)}.jsonl`), `${JSON.stringify(event)}\n`)).catch(() => {}); };
    runtime = (dependencies.createRuntime ?? createRuntime)({ broker, entryCutoffMinuteET, stopAtMs, getContracts: providers.getContracts, getQuote, calendar: providers.calendar, ledger: ledger.record, telemetry, breakoutMarginCents: 2, breakoutRangeFraction: 0.2, continuity: createContinuity({ path: paths.continuity }), dailyLossGuard: true, strategyCapital: 500, entryQuantity: 1, liquidateAt: untilClose ? close - 60_000 : liquidateAt });
    await runtime.start();
    ready = true;
    for (const [name, value] of pending.splice(0)) {
      dispatch(runtime, name, value);
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
    try { await releaseTradeAuthority?.(); } catch {}
  }
}

// Converts an Eastern wall-clock time (HH:MM) on the current Eastern date to epoch ms.
export function stopAtFromEasternClock(clock, nowMs = Date.now(), { allowPast = false } = {}) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(clock));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new RangeError('--stop-at must be HH:MM Eastern time');
  const [year, month, day] = dateInET(nowMs).split('-').map(Number);
  const wall = Date.UTC(year, month - 1, day, Number(match[1]), Number(match[2]));
  const offsetFor = (utcMs) => {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' }).formatToParts(new Date(utcMs)).find(({ type }) => type === 'timeZoneName')?.value ?? 'GMT';
    const m = name.match(/GMT([+-])(\d{2})(?::(\d{2}))?/);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) * 60_000 : 0;
  };
  const stopAtMs = wall - offsetFor(wall - offsetFor(wall));
  if (!allowPast && !(stopAtMs > nowMs)) throw new RangeError('--stop-at must be later today');
  return stopAtMs;
}

const describeError = (error) => ({ name: error?.name ?? null, code: error?.code ?? null, httpStatus: error?.httpStatus ?? null });

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length);
  const stopAtArg = process.argv.find((arg) => arg.startsWith('--stop-at='))?.slice('--stop-at='.length);
  const flattenAtArg = process.argv.find((arg) => arg.startsWith('--flatten-at='))?.slice('--flatten-at='.length);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  // Keep managing open positions if a background promise rejects; record why.
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), event: 'UNHANDLED_REJECTION', ...describeError(reason) })}\n`);
    process.exitCode = 1;
    controller.abort();
  });
  // A restart after the stop time runs in manage-only mode: no new BUYs, open
  // positions keep their exits (and the flatten backstop) until flat, then exit 0.
  Promise.resolve().then(() => {
    const started = Date.now();
    const stopAtMs = stopAtArg ? stopAtFromEasternClock(stopAtArg, started, { allowPast: true }) : null;
    const flattenAtMs = flattenAtArg ? stopAtFromEasternClock(flattenAtArg, started, { allowPast: true }) : null;
    if (stopAtMs !== null && flattenAtMs !== null && flattenAtMs < stopAtMs - 1 && flattenAtMs > started) throw new RangeError('--flatten-at must not be before --stop-at');
    return runPaper({ mode, signal: controller.signal, untilClose: process.argv.includes('--until-close'), ...(stopAtMs !== null ? { stopAtMs } : {}), ...(flattenAtMs !== null ? { flattenAtMs } : {}) });
  }).then((report) => process.stdout.write(`${JSON.stringify(report)}\n`)).catch((error) => {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), error: 'BOT_RUN_FAILED', ...describeError(error) })}\n`);
    process.exitCode = 1;
  }).finally(() => { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); });
}
