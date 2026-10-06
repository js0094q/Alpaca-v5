import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireTradeAuthority, assertLiveManualMarkerClear } from './trade-authority.mjs';
import { runPaper, stopAtFromEasternClock } from './paper.mjs';
import { PAPER_ACCOUNT_ID } from './alpaca-bot-bridge/config.mjs';

const directory = await mkdtemp(join(tmpdir(), 'v5-live-guards-'));
try {
  const lockPath = join(directory, 'authority.lock');
  const release = await acquireTradeAuthority('v5-live', { lockPath });
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).role, 'v5-live');
  await release();

  // Stale-lock recovery: only a same-role lock whose process is confirmed gone is reclaimed.
  const stale = { pid: 999999, role: 'v5-live', token: 'old', acquiredAt: '2026-01-01T00:00:00.000Z' };
  await writeFile(lockPath, `${JSON.stringify(stale)}\n`);
  await assert.rejects(acquireTradeAuthority('v5-live', { lockPath, isProcessGone: () => false }), { code: 'PAPER_TRADE_AUTHORITY_LOCKED' });
  await assert.rejects(acquireTradeAuthority('v5-paper', { lockPath, isProcessGone: () => true }), { code: 'PAPER_TRADE_AUTHORITY_LOCKED' });
  const reclaimed = await acquireTradeAuthority('v5-live', { lockPath, isProcessGone: (pid) => pid === 999999 });
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid);
  await reclaimed();

  // Concurrent reclaimers all observe the same stale owner; exactly one may acquire.
  const raceLockPath = join(directory, 'authority-race.lock');
  await writeFile(raceLockPath, `${JSON.stringify(stale)}\n`);
  const contenders = 8;
  let arrived = 0, releaseBarrier;
  const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
  const attempts = await Promise.allSettled(Array.from({ length: contenders }, () => acquireTradeAuthority('v5-live', {
    lockPath: raceLockPath,
    isProcessGone: async (pid) => { assert.equal(pid, stale.pid); if (++arrived === contenders) releaseBarrier(); await barrier; return true; },
  })));
  const winners = attempts.filter((attempt) => attempt.status === 'fulfilled');
  assert.equal(winners.length, 1, 'stale-lock reclaim grants exactly one concurrent owner');
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected' && attempt.reason.code === 'PAPER_TRADE_AUTHORITY_LOCKED').length, contenders - 1);
  await winners[0].value();

  // --stop-at converts Eastern wall-clock time across DST and rejects past times.
  assert.equal(stopAtFromEasternClock('12:00', Date.parse('2026-10-05T13:00:00Z')), Date.parse('2026-10-05T16:00:00Z'));
  assert.equal(stopAtFromEasternClock('12:00', Date.parse('2026-12-07T14:00:00Z')), Date.parse('2026-12-07T17:00:00Z'));
  assert.equal(stopAtFromEasternClock('12:00', Date.parse('2026-10-05T17:00:00Z'), { allowPast: true }), Date.parse('2026-10-05T16:00:00Z'), 'a post-noon restart remains manager-only with an already-expired stop deadline');
  assert.throws(() => stopAtFromEasternClock('09:00', Date.parse('2026-10-05T16:00:00Z')), RangeError);
  assert.throws(() => stopAtFromEasternClock('25:00'), RangeError);

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
  assert.equal(runtimeOptions.strategyCapital, 481.63);
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
