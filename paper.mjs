import { appendFile, mkdir } from 'node:fs/promises';
import { createAlpacaBroker } from './alpaca.mjs';
import { createAlpacaProviders } from './providers.mjs';
import { createRuntime } from './runtime.mjs';
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

export async function runPaper({ mode, credentials: suppliedCredentials, durationMs = DEFAULT_DURATION_MS, untilClose = false, entryCutoffMinuteET = 15 * 60 + 30, stopAtMs = null, signal, dependencies = {} } = {}) {
  if (!['paper', 'live'].includes(mode)) throw new TypeError('mode must be paper or live');
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new TypeError('durationMs must be positive');
  if (!Number.isInteger(entryCutoffMinuteET) || entryCutoffMinuteET < 0 || entryCutoffMinuteET >= 24 * 60) throw new RangeError('entryCutoffMinuteET must be an integer minute of day');
  if (stopAtMs !== null && !Number.isFinite(stopAtMs)) throw new RangeError('stopAtMs must be a finite timestamp');
  if (mode === 'live' && suppliedCredentials) throw new Error('LIVE_CREDENTIAL_OVERRIDE_FORBIDDEN');
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
      write: async (line) => {
        await mkdir(paths.directory, { recursive: true });
        await appendFile(paths.ledger, `${line}\n`);
      },
    });
    runtime = (dependencies.createRuntime ?? createRuntime)({ broker, entryCutoffMinuteET, stopAtMs, getContracts: providers.getContracts, getQuote, calendar: providers.calendar, ledger: ledger.record, continuity: createContinuity({ path: paths.continuity }), dailyLossGuard: true, strategyCapital: 500, entryQuantity: 1, liquidateAt: untilClose ? close - 60_000 : null });
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
