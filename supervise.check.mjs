import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { restartDecision, supervise, MAX_RESTARTS } from './supervise.mjs';
import { runPaper } from './paper.mjs';

const base = { stopping: false, launchDate: '2026-10-05', currentDate: '2026-10-05', restarts: 0 };
assert.equal(restartDecision({ ...base, exitCode: 1 }).restart, true, 'crash restarts');
assert.equal(restartDecision({ ...base, exitCode: null, signal: 'SIGKILL' }).restart, true, 'killed process restarts');
assert.equal(restartDecision({ ...base, exitCode: 0 }).reason, 'clean_exit');
assert.equal(restartDecision({ ...base, exitCode: 1, stopping: true }).reason, 'operator_stop');
assert.equal(restartDecision({ ...base, exitCode: 1, currentDate: '2026-10-06' }).reason, 'trading_date_changed');
assert.equal(restartDecision({ ...base, exitCode: 1, errorCode: 'CREDENTIAL_UNAVAILABLE' }).reason, 'non_transient_error');
assert.equal(restartDecision({ ...base, exitCode: 1, errorCode: 'PAPER_TRADE_AUTHORITY_LOCKED' }).reason, 'non_transient_error');
assert.equal(restartDecision({ ...base, exitCode: 1, errorName: 'RangeError' }).reason, 'invalid_arguments');
assert.equal(restartDecision({ ...base, exitCode: 1, restarts: MAX_RESTARTS }).reason, 'restart_limit');

// Loop: two crashes, then a clean drain exit ends supervision.
{
  const exits = [1, 1, 0];
  const spawned = [];
  const signalSource = new EventEmitter();
  const result = await supervise(['--mode=live', '--stop-at=12:00'], {
    now: () => Date.parse('2026-10-05T15:00:00Z'), sleep: async () => {},
    spawnChild: (args) => { spawned.push(args); const child = new EventEmitter(); child.kill = () => {}; const code = exits.shift(); setImmediate(() => child.emit('close', code, null)); return child; },
    signalSource,
  });
  assert.equal(spawned.length, 3);
  assert.equal(result.reason, 'clean_exit');
  assert.equal(result.restarts, 2);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0, 'signal handlers are removed after supervision');
  assert.equal(signalSource.listenerCount('SIGINT'), 0, 'signal handlers are removed after supervision');
}

// Operator shutdown reaches the active child and never starts a retry.
{
  const signalSource = new EventEmitter();
  let spawned = 0, killed = null;
  const result = await supervise(['--mode=live'], {
    now: () => Date.parse('2026-10-05T15:00:00Z'), sleep: async () => {}, signalSource,
    spawnChild: () => {
      spawned++;
      const child = new EventEmitter();
      child.kill = (signal) => { killed = signal; setImmediate(() => child.emit('close', null, signal)); };
      setImmediate(() => signalSource.emit('SIGTERM'));
      return child;
    },
  });
  assert.equal(result.reason, 'operator_stop');
  assert.equal(spawned, 1);
  assert.equal(killed, 'SIGTERM');
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
}

// A failure just before midnight Eastern is not relaunched after backoff crosses into tomorrow.
{
  let clock = Date.parse('2026-10-06T03:59:59Z');
  let spawned = 0;
  const result = await supervise(['--mode=live'], {
    now: () => clock, sleep: async (ms) => { clock += ms; }, signalSource: new EventEmitter(),
    spawnChild: () => { spawned++; const child = new EventEmitter(); child.kill = () => {}; setImmediate(() => child.emit('close', 1, null)); return child; },
  });
  assert.equal(result.reason, 'trading_date_changed');
  assert.equal(spawned, 1);
}

// Split stdout chunks still identify a non-transient failure before any retry.
{
  let spawned = 0;
  const result = await supervise(['--mode=live'], {
    now: () => Date.parse('2026-10-05T15:00:00Z'), signalSource: new EventEmitter(),
    spawnChild: () => {
      spawned++;
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {};
      setImmediate(() => {
        child.stdout.emit('data', '{"name":"Error","code":"CREDENTIAL_');
        child.stdout.emit('data', 'UNAVAILABLE"}\n');
        child.emit('close', 1, null);
      });
      return child;
    },
  });
  assert.equal(result.reason, 'non_transient_error');
  assert.equal(spawned, 1);
}

// Spawn errors settle the child wait and remain bounded by the retry limit.
{
  let spawned = 0;
  const result = await supervise(['--mode=live'], {
    now: () => Date.parse('2026-10-05T15:00:00Z'), sleep: async () => {}, signalSource: new EventEmitter(),
    spawnChild: () => { spawned++; const child = new EventEmitter(); child.kill = () => {}; setImmediate(() => child.emit('error', Object.assign(new Error('mock spawn failure'), { code: 'ENOENT' }))); return child; },
  });
  assert.equal(result.reason, 'restart_limit');
  assert.equal(spawned, MAX_RESTARTS + 1);
}

// After the stop time: no BUYs (runtime gets stopAtMs) and the run waits until the
// broker shows no SPY option exposure before it returns.
{
  let polls = 0;
  let runtimeOptions;
  const started = Date.now();
  const report = await runPaper({
    mode: 'live', stopAtMs: started + 20, flattenAtMs: started + 30,
    dependencies: {
      loadModeCredentials: async () => ({ key: 'mock', secret: 'mock' }),
      createBroker: () => ({ inspectCurrentState: async () => ({ account: { id: 'mock-live' }, positions: [], orders: [] }) }),
      assertLiveAccount: async () => {}, acquireTradeAuthority: async () => async () => {}, assertLiveManualMarkerClear: async () => {},
      createProviders: () => ({ connect: () => ({ subscribeOptions() {}, stop() {} }), calendar: {
        loadCalendar: async () => {},
        sessionFor: () => ({ date: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(started), close: new Date(started + 3_600_000).toISOString(), status: 'open' }),
      } }),
      createRuntime: (options) => { runtimeOptions = options; return {
        start: async () => {}, stop() {}, stopEntries() {}, hasOwnership: () => polls < 2,
        getState: () => ({ state: 'MANAGING', entry: { active: false } }),
        inspectCurrentOwnership: async () => { polls += 1; return { positions: polls < 2 ? [{ symbol: 'SPY261005C00660000', qty: '1' }] : [], orders: [] }; },
      }; },
    },
  });
  assert.equal(runtimeOptions.stopAtMs, started + 20, 'entries stop at the deadline');
  assert.equal(runtimeOptions.liquidateAt, started + 30, 'flatten backstop reaches the runtime');
  assert.equal(polls, 2, 'run waited for the open position to close');
  assert.equal(report.mode, 'live');
}

// SIGTERM-style abort stops entries and waits for observed flatness before runtime shutdown.
{
  const controller = new AbortController();
  let stopEntries = false, runtimeStopped = false, polls = 0;
  const result = await runPaper({ mode: 'live', durationMs: 60_000, signal: controller.signal, dependencies: {
    loadModeCredentials: async () => ({ key: 'mock', secret: 'mock' }),
    createBroker: () => ({ inspectCurrentState: async () => ({ account: { id: 'mock-live' }, positions: [], orders: [] }) }),
    assertLiveAccount: async () => {}, acquireTradeAuthority: async () => async () => {}, assertLiveManualMarkerClear: async () => {},
    createProviders: () => ({ connect: () => ({ subscribeOptions() {}, stop() {} }), calendar: { loadCalendar: async () => {} } }),
    createRuntime: () => ({
      start: async () => { setImmediate(() => controller.abort()); },
      stopEntries: () => { stopEntries = true; },
      stop: () => { runtimeStopped = true; },
      getState: () => ({ state: 'MANAGING', entry: { active: false } }),
      hasOwnership: () => polls < 2,
      inspectCurrentOwnership: async () => { polls++; return { positions: polls < 2 ? [{ symbol: 'SPY261005C00660000', qty: '1' }] : [], orders: [] }; },
    }),
  } });
  assert.equal(stopEntries, true);
  assert.equal(polls, 2, 'SIGTERM path drains before returning');
  assert.equal(runtimeStopped, true);
  assert.equal(result.mode, 'live');
}

// An early session close takes precedence over the configured 15:45 flatten deadline.
{
  let runtimeOptions;
  const started = Date.now();
  const close = started + 30_000;
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(started);
  await runPaper({ mode: 'live', durationMs: 1, flattenAtMs: started + 120_000, dependencies: {
    loadModeCredentials: async () => ({ key: 'mock', secret: 'mock' }),
    createBroker: () => ({ inspectCurrentState: async () => ({ account: { id: 'mock-live' }, positions: [], orders: [] }) }),
    assertLiveAccount: async () => {}, acquireTradeAuthority: async () => async () => {}, assertLiveManualMarkerClear: async () => {},
    createProviders: () => ({ connect: () => ({ subscribeOptions() {}, stop() {} }), calendar: { loadCalendar: async () => {}, sessionFor: () => ({ date, close: new Date(close).toISOString(), status: 'open' }) } }),
    createRuntime: (options) => { runtimeOptions = options; return {
      start: async () => {}, stop() {}, hasOwnership: () => false,
      getState: () => ({ state: 'FLAT', entry: { active: false } }),
      inspectCurrentOwnership: async () => ({ positions: [], orders: [] }),
    }; },
  } });
  assert.equal(runtimeOptions.liquidateAt, close - 60_000, 'flatten is scheduled 60 seconds before an early close');
}

// Missing today's session close cannot silently fall back to an after-close 15:45 attempt.
{
  let released = false, runtimeCreated = false;
  const started = Date.now();
  const nextDate = '1900-01-01';
  await assert.rejects(runPaper({ mode: 'live', durationMs: 1, flattenAtMs: started + 120_000, dependencies: {
    loadModeCredentials: async () => ({ key: 'mock', secret: 'mock' }),
    createBroker: () => ({ inspectCurrentState: async () => ({ account: { id: 'mock-live' }, positions: [], orders: [] }) }),
    assertLiveAccount: async () => {}, acquireTradeAuthority: async () => async () => { released = true; }, assertLiveManualMarkerClear: async () => {},
    createProviders: () => ({ connect: () => ({ subscribeOptions() {}, stop() {} }), calendar: { loadCalendar: async () => {}, sessionFor: () => ({ date: nextDate, close: new Date(started + 86_400_000).toISOString(), status: 'closed' }) } }),
    createRuntime: () => { runtimeCreated = true; throw new Error('runtime must not start without today close'); },
  } }), { code: 'LIVE_FLATTEN_SESSION_UNKNOWN' });
  assert.equal(runtimeCreated, false);
  assert.equal(released, true);
}
console.log('supervisor restart rules and post-deadline drain checks passed');
