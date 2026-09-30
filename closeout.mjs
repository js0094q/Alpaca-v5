import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createAlpacaBroker } from './alpaca.mjs';
import { createAlpacaProviders } from './providers.mjs';
import { createRuntime } from './runtime.mjs';
import { createLedger } from './ledger.mjs';
import { createContinuity } from './continuity.mjs';
import { PAPER_ENV, paperAccountPaths } from './paper-account.mjs';

const DEFAULT_ENV = PAPER_ENV;
const PAPER_URL = 'https://paper-api.alpaca.markets';
const STREAMS = {
  sip: 'wss://stream.data.alpaca.markets/v2/sip',
  opra: 'wss://stream.data.alpaca.markets/v1beta1/opra',
  tradeUpdates: 'wss://paper-api.alpaca.markets/stream',
};

const parseEnv = (text) => Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
  const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  return match ? [[match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]] : [];
}));

const safeError = () => 'RUN_FAILED';

export function createCloseoutBroker(options) {
  const broker = createAlpacaBroker({ ...options, baseUrl: PAPER_URL });
  const mutations = [];
  const blocked = (operation) => async () => {
    mutations.push(operation);
    throw new Error(`design-closeout mutation blocked: ${operation}`);
  };
  return {
    ...broker,
    submitOrder: blocked('submit'),
    replaceOrder: blocked('replace'),
    cancelOrder: blocked('cancel'),
    mutationAttempts: () => [...mutations],
  };
}

export async function loadCloseoutCredentials(path = DEFAULT_ENV) {
  const values = parseEnv(await readFile(path, 'utf8'));
  if (!values.APCA_API_KEY || !values.APCA_SECRET_KEY) throw new Error('required Alpaca credentials are missing');
  return { key: values.APCA_API_KEY, secret: values.APCA_SECRET_KEY };
}

const statusName = (value) => {
  const frame = value?.frame;
  if (frame?.T === 'success' && /auth/i.test(frame.msg ?? '')) return 'authenticated';
  if (frame?.stream === 'authorization' && frame.data?.status === 'authorized') return 'authenticated';
  if (frame?.stream === 'listening') return 'subscribed';
  if (frame?.T === 'subscription') return 'subscribed';
  if (frame?.T === 'error') return 'error';
  if (value?.status === 'connected') return 'connected';
  return null;
};

export async function runCloseout({ envPath = DEFAULT_ENV, durationMs = 10_000 } = {}) {
  const credentials = await loadCloseoutCredentials(envPath);
  const deadline = Date.now() + Math.min(Math.max(durationMs, 1_000), 45_000);
  const statuses = Object.fromEntries(Object.keys(STREAMS).map((name) => [name, { connected: false, authenticated: false, subscribed: false, messages: 0, errors: [] }]));
  const rest = { account: false, positions: false, openOrders: false, calendar: false, contracts: false, quote: false };
  const http = { requests: 0, mutationRequests: 0 };
  const fetchImpl = (url, options = {}) => {
    const method = String(options.method ?? 'GET').toUpperCase();
    http.requests += 1;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      http.mutationRequests += 1;
      throw new Error('design-closeout HTTP mutation blocked');
    }
    const remaining = Math.max(1, Math.min(5_000, deadline - Date.now()));
    return fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(remaining) });
  };
  const providers = createAlpacaProviders({ ...credentials, baseUrl: PAPER_URL, fetchImpl });
  const broker = createCloseoutBroker({ ...credentials, fetchImpl });
  let stage = 'connect';
  let runtime;
  let ready = false;
  let connection;
  let subscribeOptions = () => {};
  const pending = [];
  let selectedOption;
  const streamFor = (stream) => Object.entries(STREAMS).find(([, url]) => url === stream)?.[0];
  const onStatus = ({ stream, ...value }) => {
    const name = streamFor(stream);
    if (!name) return;
    const status = statusName(value);
    if (status === 'connected') statuses[name].connected = true;
    if (status === 'authenticated') statuses[name].authenticated = true;
    if (status === 'subscribed') {
      const data = value.frame?.data ?? value.frame ?? {};
      const valid = name === 'sip' ? data.trades?.includes('SPY')
        : name === 'opra' ? data.quotes?.includes(selectedOption)
          : data.streams?.includes('trade_updates');
      if (valid) statuses[name].subscribed = true;
    }
    if (status === 'error') statuses[name].errors.push('provider error');
  };
  const dispatch = (name, value) => {
    if (name === 'sip') runtime.onRawTrade(value); else if (name === 'opra') runtime.onQuote(value); else runtime.onOrderUpdate(value);
  };
  const onMessage = (name, value) => { statuses[name].messages += 1; if (!ready) pending.push([name, value]); else dispatch(name, value); };
  try {
    connection = providers.connect({
      onStatus,
      onDisconnect: () => { if (ready) runtime.onMarketDataReconnect(); },
      onRawTrade: (value) => onMessage('sip', value),
      onQuote: (value) => onMessage('opra', value),
      onTradeUpdate: (value) => onMessage('tradeUpdates', value),
      optionSymbols: [],
    });
    stage = 'account_positions_orders';
    const snapshot = await broker.inspectCurrentState();
    const paths = paperAccountPaths(snapshot.account);
    rest.account = Boolean(snapshot.account);
    rest.positions = Array.isArray(snapshot.positions);
    rest.openOrders = Array.isArray(snapshot.orders);
    const now = new Date();
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const end = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now.getTime() + 7 * 86_400_000));
    stage = 'calendar';
    await providers.calendar.loadCalendar({ start: date, end });
    rest.calendar = true;
    stage = 'contracts';
    const contracts = await providers.getContracts('CALL', now.toISOString());
    rest.contracts = true;
    stage = 'latest_trade';
    const latest = await providers.getLatestTrade();
    const candidate = contracts.length && latest?.price == null ? contracts[0] : contracts.reduce((best, item) => Math.abs(item.strike - latest.price) < Math.abs(best.strike - latest.price) ? item : best, contracts[0]);
    selectedOption = candidate?.symbol;
    subscribeOptions = (symbols) => connection.subscribeOptions(symbols);
    const getQuote = async (symbol) => { subscribeOptions([symbol]); return providers.getQuote(symbol); };
    stage = 'quote';
    if (selectedOption) rest.quote = Boolean(await getQuote(selectedOption));
    subscribeOptions((snapshot.positions ?? []).map((position) => position.symbol).filter((symbol) => /^SPY\d{6}[CP]\d{8}$/.test(String(symbol))));
    const ledger = createLedger({ write: async (line) => { await mkdir(paths.directory, { recursive: true }); await appendFile(paths.closeoutLedger, `${line}\n`); } });
    const continuity = createContinuity({ path: paths.continuity });
    runtime = createRuntime({ broker, getContracts: providers.getContracts, getQuote, calendar: providers.calendar, ledger: ledger.record, continuity });
    stage = 'runtime_start';
    await runtime.start();
    ready = true;
    for (const [name, value] of pending.splice(0)) dispatch(name, value);
    while (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    return { rest, streams: statuses, selectedOption, runtime: runtime.getState(), mutationAttempts: broker.mutationAttempts(), http, boundedRunMs: Math.min(Math.max(durationMs, 1_000), 45_000) };
  } catch (error) {
    return { rest, streams: statuses, failure: { stage, httpStatus: Number.isInteger(error?.httpStatus) ? error.httpStatus : null }, mutationAttempts: broker.mutationAttempts(), http, boundedRunMs: Math.min(Math.max(durationMs, 1_000), 45_000) };
  } finally {
    connection?.stop();
    ready = false;
    runtime?.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCloseout().then((report) => { process.stdout.write(`${JSON.stringify(report)}\n`); }).catch((error) => { process.stdout.write(`${JSON.stringify({ error: safeError(error), mutationAttempts: [] })}\n`); process.exitCode = 1; });
}
