import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAlpacaBroker } from '../alpaca.mjs';
import { createAlpacaProviders, createCalendar } from '../providers.mjs';
import { launchMarketOpen } from '../market-open.mjs';
import { modeAccountPaths, loadModeAccountPaths } from '../paper-account.mjs';
import { runPaper } from '../paper.mjs';
import { acquireTradeAuthority, joinOwnedPositions, localSnapshot, processIdentity, readLocalHistory, readPostExitEvidence, requireMode, tools } from './runtime.mjs';

const PAPER = 'https://paper-api.alpaca.markets';
const LIVE = 'https://api.alpaca.markets';
const flush = () => new Promise((resolve) => setImmediate(resolve));

assert.throws(() => requireMode(undefined), /PAPER only/);
assert.throws(() => requireMode('live'), /PAPER only/);
assert.throws(() => requireMode('sandbox'), /PAPER only/);
assert.equal(requireMode('paper'), 'paper');
const paperCommand = `/opt/homebrew/bin/node ${new URL('../paper.mjs', import.meta.url).pathname} --mode=paper`;
assert.equal(processIdentity(paperCommand).mode, 'paper');
for (const tool of tools.filter(({ name }) => name.startsWith('bot_'))) {
  assert.equal(Object.hasOwn(tool.inputSchema.properties, 'mode'), false, `${tool.name} has no public mode selector`);
  assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} rejects extra selectors`);
}
assert.ok(['bot_start', 'bot_stop', 'bot_restart'].every((name) => !tools.some((tool) => tool.name === name)), 'monitor catalog excludes lifecycle tools');
const actualStatus = await tools.find(({ name }) => name === 'bot_status').handler({});
assert.equal(actualStatus.mode, 'paper');
assert.ok(['available', 'unavailable'].includes(actualStatus.processScan), 'bot status reads current local process state');
await assert.rejects(readLocalHistory({ mode: 'live', date: '2026-09-25' }), /PAPER only/);
await assert.rejects(readLocalHistory({ mode: 'paper', date: 'bad-date' }), /YYYY-MM-DD/);
const historyFixture = await mkdtemp(join(tmpdir(), 'v5-history-check-'));
const historyFile = 'v5-trace-1790349985405-2fcb3a83-36f0-43d6-9afe-803fa3082437-000002.jsonl';
const historyRows = Array.from({ length: 6 }, (_, index) => ({ runId: 'fixture-run', event: 'position_exit', wallTimeMs: 1790349985500 + index, fields: { tradeId: `fixture-trade-${index}` } }));
await writeFile(join(historyFixture, historyFile), historyRows.map(JSON.stringify).join('\n') + '\n');
const retained = await readLocalHistory({ mode: 'paper', date: '2026-09-25', file: historyFile, eventNames: ['position_exit'], limit: 5 }, { directory: historyFixture });
await rm(historyFixture, { recursive: true, force: true });
assert.equal(retained.provenance, 'legacy_global_paper_trace_account_unverified');
assert.ok(retained.sessions[0]?.events.some(({ event }) => event === 'position_exit'), 'historical session yields retained exit evidence');
assert.equal(retained.truncated, true, 'history reports remaining paginated records');
assert.throws(() => modeAccountPaths('sandbox', { id: 'a' }));
assert.notEqual(modeAccountPaths('paper', { id: 'same' }).directory, modeAccountPaths('live', { id: 'same' }).directory);
await assert.rejects(loadModeAccountPaths('live', { key: 'k', secret: 's' }, PAPER, async () => { throw new Error('must not request'); }), /do not match/);
await assert.rejects(runPaper({}), /mode must be paper or live/);
let liveBrokerConstructed = false;
await assert.rejects(runPaper({ mode: 'live', dependencies: {
  loadModeCredentials: async () => { throw Object.assign(new Error('LIVE credentials are unavailable.'), { code: 'CREDENTIAL_UNAVAILABLE' }); },
  createBroker: () => { liveBrokerConstructed = true; throw new Error('must not construct broker'); },
} }), (error) => error.code === 'CREDENTIAL_UNAVAILABLE' && error.message === 'LIVE credentials are unavailable.');
assert.equal(liveBrokerConstructed, false, 'missing mocked LIVE credentials fail before broker construction');
await assert.rejects(localSnapshot('live'), /PAPER only/);

const brokerUrls = [];
const broker = createAlpacaBroker({ key: 'key', secret: 'secret', baseUrl: LIVE, fetchImpl: async (url) => {
  brokerUrls.push(url);
  return { ok: true, text: async () => JSON.stringify(url.endsWith('/v2/account') ? { id: 'live-id' } : []) };
} });
await broker.inspectCurrentState();
assert.deepEqual(brokerUrls, [`${LIVE}/v2/account`, `${LIVE}/v2/positions`, `${LIVE}/v2/orders?status=open&nested=true&direction=asc`]);
assert.throws(() => createAlpacaBroker({ key: 'k', secret: 's' }), /Unsupported Alpaca API URL/);

const providerUrls = [], sockets = [];
class MockSocket {
  readyState = 1;
  handlers = new Map();
  constructor(url) { this.url = url; sockets.push(this); }
  addEventListener(name, fn) { this.handlers.set(name, fn); }
  send() {}
  close() { this.readyState = 3; }
}
const fetchImpl = async (url) => {
  providerUrls.push(url);
  return { ok: true, text: async () => JSON.stringify(url.includes('/calendar') ? [] : { option_contracts: [], next_page_token: null }) };
};
const providers = createAlpacaProviders({ key: 'key', secret: 'secret', baseUrl: LIVE, fetchImpl, WebSocketImpl: MockSocket });
await providers.calendar.loadCalendar({ start: '2026-09-28', end: '2026-09-28' });
await providers.getContracts('CALL', '2026-09-28T13:30:00Z');
const connection = providers.connect();
assert.ok(providerUrls.every((url) => url.startsWith(LIVE)));
assert.deepEqual(sockets.map(({ url }) => url), ['wss://stream.data.alpaca.markets/v2/sip', 'wss://stream.data.alpaca.markets/v1beta1/opra', 'wss://api.alpaca.markets/stream']);
connection.stop();
assert.throws(() => createCalendar({}), /Unsupported Alpaca API URL/);

const temp = await mkdtemp(join(tmpdir(), 'v5-bridge-check-'));
try {
  const lockPath = join(temp, 'trade-authority.lock');
  const release = await acquireTradeAuthority('bridge-manual', { lockPath });
  await assert.rejects(acquireTradeAuthority('v5-paper', { lockPath }), (error) => error.code === 'PAPER_TRADE_AUTHORITY_LOCKED');
  assert.equal(await release(), true);
  assert.equal(await release(), false);
  const [owned] = joinOwnedPositions([{ tradeId: 'fill-1:1', executionId: 'fill-1', symbol: 'SPY260925P00768000', remainingQty: 1, sellLatched: true, logicalSellId: 'sell-1', orderId: 'sell-order-1' }], {
    fills: [{ id: 'fill-1', symbol: 'SPY260925P00768000', side: 'buy', order_id: 'buy-order-1' }],
    orders: [{ id: 'buy-order-1', side: 'buy', client_order_id: 'v5-buy-set-1' }],
    openOrders: [{ id: 'sell-order-1', side: 'sell', symbol: 'SPY260925P00768000', client_order_id: 'sell-1' }],
  });
  assert.equal(owned.entryFillMatch, 'exact_execution_id');
  assert.equal(owned.tradeSetId, 'v5-buy-set-1');
  assert.equal(owned.sellOrderMatch, 'exact_order_or_client_order_id');
  const [normalizedActivity] = joinOwnedPositions([{ executionId: '11111111-1111-4111-8111-111111111111', symbol: 'SPY260925P00768000', tradeSetId: 'retained-set' }], {
    fills: [{ id: `20260925151546216::${'11111111-1111-4111-8111-111111111111'}`, symbol: 'SPY260925P00768000', side: 'buy', order_id: 'missing-from-page' }], orders: [],
  });
  assert.equal(normalizedActivity.entryFillMatch, 'exact_execution_id');
  assert.equal(normalizedActivity.tradeSetId, 'retained-set');
  const evidenceDirectory = join(temp, 'post-exit-evidence');
  await mkdir(evidenceDirectory);
  const evidenceFile = `post-exit-${'a'.repeat(64)}.jsonl`;
  const records = ['POST_EXIT_START', 'POST_EXIT_QUOTE', 'POST_EXIT_GAP', 'POST_EXIT_END'].map((event, index) => ({
    event, wallTimeMs: 1790363000000 + index * 1000,
    fields: { mode: 'paper', accountHash: 'fixture-account', tradeId: 'fixture-lot', status: event === 'POST_EXIT_END' ? 'complete' : undefined },
  }));
  await writeFile(join(evidenceDirectory, evidenceFile), records.map(JSON.stringify).join('\n'));
  const evidence = await readPostExitEvidence({ directory: temp, accountHash: 'fixture-account' }, 'paper', 2);
  assert.equal(evidence.windows[0].coverage.eventCounts.POST_EXIT_QUOTE, 1);
  assert.equal(evidence.windows[0].coverage.eventCounts.POST_EXIT_GAP, 1);
  assert.equal(evidence.windows[0].nextOffset, 2);
  const next = await readPostExitEvidence({ directory: temp, accountHash: 'fixture-account' }, 'paper', 2, 2, evidenceFile);
  assert.equal(next.windows[0].events[1].event, 'POST_EXIT_END');
  assert.equal(next.truncated, false);
  await assert.rejects(readPostExitEvidence({ directory: temp, accountHash: 'fixture-account' }, 'live', 10), /PAPER only/);
  const now = () => Date.parse('2026-09-25T13:30:00Z');
  const ran = [];
  const result = await launchMarketOpen({ mode: 'live', credentials: { key: 'key', secret: 'secret' }, baseUrl: LIVE, resume: true,
    now, sleep: async () => {}, calendar: async (date, settings) => {
      assert.equal(settings.mode, 'live'); assert.equal(settings.baseUrl, LIVE);
      return [{ date, open: '2026-09-25T13:30:00.000Z', close: '2026-09-25T20:00:00.000Z' }];
    }, active: async () => false, started: async () => false, stateDirectory: temp,
    accountPaths: async () => ({ marketOpen: temp, ledger: join(temp, 'ledger') }),
    run: async (options) => { ran.push(options); return { mode: 'live', runtime: { state: 'WAITING' } }; },
  });
  assert.equal(result.status, 'completed');
  assert.equal(ran.length, 1);
  assert.equal(ran[0].mode, 'live');
  assert.equal(ran[0].untilClose, false);
  assert.equal(ran[0].stopAtMs, Date.parse('2026-09-25T19:30:00Z'));
  await flush();
} finally { await rm(temp, { recursive: true, force: true }); }

console.log('Bridge runtime mode, isolation, and non-trading checks passed.');
