import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIVE_ENV, loadModeCredentials } from '../../paper-account.mjs';
import { launchMarketOpen } from '../../market-open.mjs';
import { runPaper } from '../../paper.mjs';
import { runLive } from './run-live.mjs';

let readPath;
const credentials = await loadModeCredentials('live', { readFileImpl: async (path) => {
  readPath = path;
  return 'APCA_API_KEY=fake-key\nAPCA_SECRET_KEY=fake-secret\n';
} });
assert.equal(readPath, LIVE_ENV);

const stateDirectory = await mkdtemp(join(tmpdir(), 'v5-live-launch-check-'));
const now = Date.parse('2026-09-28T13:32:00Z');
let calendarContext;
let credentialMode;
let authority;
let released = false;
let runtimeStopped = false;
let accountPathsUsed = false;
const runtime = {
  start: async () => {},
  stop: () => { runtimeStopped = true; },
  inspectCurrentOwnership: async () => ({ positions: [], orders: [] }),
  getState: () => ({ state: 'FLAT', entry: { active: false } }),
  hasOwnership: () => false,
};
const dependencies = {
  loadModeCredentials: async (mode) => { credentialMode = mode; return credentials; },
  acquireTradeAuthority: async (name) => { authority = name; return async () => { released = true; }; },
  createBroker: () => ({ inspectCurrentState: async () => ({
    account: { id: 'mock-live-account', status: 'ACTIVE', account_blocked: false, trading_blocked: false, trade_suspended_by_user: false },
    positions: [], orders: [],
  }) }),
  assertLiveManualMarkerClear: async () => {},
  createProviders: () => ({
    connect: () => ({ subscribeOptions: () => {}, stop: () => {} }),
    calendar: { loadCalendar: async () => {} },
    getContracts: async () => [],
    getQuote: async () => null,
  }),
  createRuntime: () => runtime,
};

const result = await runLive({
  credentialsLoader: async () => credentials,
  activeCheck: async () => false,
  runPaperImpl: (options) => {
    assert.equal(Object.hasOwn(options, 'credentials'), false);
    return runPaper({ ...options, dependencies });
  },
  launch: (options) => launchMarketOpen({
    ...options,
    now: () => now,
    started: async () => false,
    accountPaths: async () => {
      accountPathsUsed = true;
      return { marketOpen: stateDirectory, ledger: join(stateDirectory, 'ledger.log') };
    },
    calendar: async (date, context) => {
      calendarContext = { date, context };
      return [{ date, open: '2026-09-28T13:30:00Z', close: '2026-09-28T20:00:00Z' }];
    },
  }),
});

assert.equal(result.status, 'completed');
assert.equal(result.mode, 'live');
assert.equal(result.runtimeState, 'FLAT');
assert.equal(calendarContext.date, '2026-09-28');
assert.equal(calendarContext.context.mode, 'live');
assert.equal(calendarContext.context.credentials, credentials);
assert.equal(accountPathsUsed, true);
assert.equal(credentialMode, 'live');
assert.equal(authority, 'v5-live');
assert.equal(released, true);
assert.equal(runtimeStopped, true);
const claim = JSON.parse(await readFile(join(stateDirectory, '2026-09-28.claim'), 'utf8'));
assert.equal(claim.mode, 'live');
assert.equal(claim.marketOpen, '2026-09-28T13:30:00Z');
console.log('run-live.check ok (mocked credentials, account lookup, calendar, broker, providers, runtime, and order path)');
