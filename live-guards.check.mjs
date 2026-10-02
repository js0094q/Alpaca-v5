import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireTradeAuthority, assertLiveManualMarkerClear } from './trade-authority.mjs';
import { runPaper } from './paper.mjs';
import { PAPER_ACCOUNT_ID } from './alpaca-bot-bridge/config.mjs';

const directory = await mkdtemp(join(tmpdir(), 'v5-live-guards-'));
try {
  const lockPath = join(directory, 'authority.lock');
  const release = await acquireTradeAuthority('v5-live', { lockPath });
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).role, 'v5-live');
  await release();

  const markerPath = join(directory, 'manual.json');
  assert.deepEqual(await assertLiveManualMarkerClear({ markerPath }), { status: 'none' });
  await writeFile(markerPath, JSON.stringify({ schema: 1, accountId: PAPER_ACCOUNT_ID, orders: [{ clientOrderId: 'bridge-manual-test' }] }));
  await assert.rejects(assertLiveManualMarkerClear({ markerPath }), { code: 'MANUAL_OWNERSHIP_UNRESOLVED' });

  const calls = [];
  const stopAtRuntimeStart = new Error('mock runtime boundary');
  let runtimeOptions;
  await assert.rejects(runPaper({
    mode: 'live', durationMs: 1000,
    dependencies: {
      loadModeCredentials: async (mode) => { calls.push(`credentials:${mode}`); return { key: 'mock', secret: 'mock' }; },
      createBroker: () => ({ inspectCurrentState: async () => { calls.push('snapshot'); return { account: { id: 'mock-live' }, positions: [], orders: [] }; } }),
      assertLiveAccount: async (account, { baseUrl }) => { calls.push(`account:${account.id}:${baseUrl}`); },
      acquireTradeAuthority: async (role) => { calls.push(`authority:${role}`); return async () => calls.push('release'); },
      assertLiveManualMarkerClear: async () => calls.push('marker'),
      createProviders: () => ({ connect: () => { calls.push('provider-connect'); return { subscribeOptions() {}, stop() {} }; }, calendar: { loadCalendar: async () => {} } }),
      createRuntime: (options) => { runtimeOptions = options; calls.push('runtime-created'); return { start: async () => { calls.push('runtime-start'); throw stopAtRuntimeStart; }, stop() { calls.push('runtime-stop'); } }; },
    },
  }), (error) => error === stopAtRuntimeStart);
  assert.deepEqual(calls, [
    'credentials:live', 'authority:v5-live', 'snapshot', 'account:mock-live:https://api.alpaca.markets',
    'marker', 'provider-connect', 'runtime-created', 'runtime-start', 'runtime-stop', 'release',
  ]);
  assert.equal(runtimeOptions.dailyLossGuard, true);
  assert.equal(runtimeOptions.strategyCapital, 500);
  assert.equal(runtimeOptions.entryQuantity, 1);

  const rejectedCalls = [];
  await assert.rejects(runPaper({ mode: 'live', durationMs: 1000, dependencies: {
    loadModeCredentials: async () => ({ key: 'mock', secret: 'mock' }),
    createBroker: () => ({ inspectCurrentState: async () => { rejectedCalls.push('snapshot'); return { account: { id: 'wrong' }, positions: [], orders: [] }; } }),
    acquireTradeAuthority: async (role) => { rejectedCalls.push(`authority:${role}`); return async () => rejectedCalls.push('release'); },
    assertLiveAccount: async () => { rejectedCalls.push('account-check'); throw new Error('mock account rejection'); },
    createProviders: () => { rejectedCalls.push('providers-created'); throw new Error('must not construct providers'); },
  } }), /mock account rejection/);
  assert.deepEqual(rejectedCalls, ['authority:v5-live', 'snapshot', 'account-check', 'release']);

  await assert.rejects(runPaper({ mode: 'live', credentials: { key: 'override', secret: 'override' } }), { message: 'LIVE_CREDENTIAL_OVERRIDE_FORBIDDEN' });
  console.log(JSON.stringify({ passed: true, checks: 'LIVE authority, fail-closed manual marker, account verification before provider/runtime startup, strict credentials and risk limits', brokerRequests: 0 }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
