import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCalendar } from './providers.mjs';
import { activeV5, launchMarketOpen, ledgerStarted } from './market-open.mjs';

const launchPaper = (options) => launchMarketOpen({ mode: 'paper', ...options });

export async function demo() {
  const directory = await mkdtemp(join(tmpdir(), 'v5-market-open-check-'));
  let calls = 0;
  const mockCalendar = (close = '16:00', holiday = false) => async (date) => {
    const calendar = createCalendar({ baseUrl: 'https://paper-api.alpaca.markets', fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify(holiday ? [] : [{ date, open: '09:30', close }]) }) });
    return calendar.loadCalendar({ start: date, end: date });
  };
  const scenario = (time, overrides = {}) => {
    let clock = Date.parse(time);
    const runs = [];
    const options = { now: () => clock, sleep: async (ms) => { assert.ok(ms <= 60_000); clock += ms; }, calendar: mockCalendar(), active: async () => false,
      started: async () => false, stateDirectory: join(directory, String(calls++)), run: async (options) => { runs.push({ at: clock, ...options }); return { runtime: { state: 'MANAGING' } }; }, ...overrides };
    return { options, runs, time: () => clock };
  };
  try {
    const root = dirname(fileURLToPath(import.meta.url));
    const processOptions = { cwdFor: async () => root, sourceFor: async (path) => path === '/tmp/v5-restart.mjs' ? `import { runPaper } from '${root}/paper.mjs'; await runPaper();` : 'startUnrelatedHelper();' };
    const unrelated = ['/Applications/ChatGPT.app/Contents/Resources/cua-repl.mjs', '/Users/josephstew/Tunnel/plugins/gpt-codex-bridge/src/codex-connector.mjs', '/Users/josephstew/.npm/_npx/example/xcodebuildmcp'];
    assert.equal(await activeV5({ ...processOptions, processList: unrelated.map((script, index) => `${900001 + index} /opt/homebrew/bin/node ${script} mcp`).join('\n') }), false);
    for (const args of [`${root}/paper.mjs`, `${root}/market-open.mjs`, 'paper.mjs', `/tmp/v5-restart.mjs`, `--input-type=module -e "import { runPaper } from '${root}/paper.mjs'; await runPaper();"`, `--input-type=module -e "import { runPaper } from './paper.mjs'; await runPaper();"`, '--input-type=module -']) {
      assert.equal(await activeV5({ ...processOptions, processList: `900004 /opt/homebrew/bin/node ${args}` }), true, args);
    }
    assert.equal(await activeV5({ ...processOptions, processList: '900004 /opt/homebrew/bin/node -e "console.log(1)"' }), false);
    for (const args of [`--require preload.cjs ${root}/paper.mjs`, '--import loader.mjs ./market-open.mjs']) {
      assert.equal(await activeV5({ ...processOptions, processList: `900004 /opt/homebrew/bin/node ${args}` }), true, args);
    }
    const normal = scenario('2026-09-25T13:28:00Z');
    const result = await launchPaper(normal.options);
    assert.equal(result.status, 'completed');
    assert.deepEqual(normal.runs, [{ at: Date.parse('2026-09-25T13:30:00Z'), mode: 'paper', durationMs: 6 * 60 * 60_000, stopAtMs: Date.parse('2026-09-25T19:30:00Z'), untilClose: false }]);
    assert.equal(result.startDelayMs, 0);
    assert.equal(JSON.parse(await readFile(join(normal.options.stateDirectory, '2026-09-25.claim'))).mode, 'paper');
    assert.equal((await launchPaper(normal.options)).reason, 'already-started');
    assert.equal(normal.runs.length, 1);

    const holiday = scenario('2026-12-25T14:28:00Z', { calendar: mockCalendar('16:00', true) });
    assert.equal((await launchPaper(holiday.options)).reason, 'closed-date');
    assert.equal(holiday.runs.length, 0);
    const running = scenario('2026-09-25T14:00:00Z', { active: async () => true });
    assert.equal((await launchPaper(running.options)).reason, 'active-v5');
    assert.equal(running.runs.length, 0);
    const prior = scenario('2026-09-25T14:00:00Z', { started: async () => true });
    assert.equal((await launchPaper(prior.options)).reason, 'already-started');
    assert.equal(prior.runs.length, 0);
    const late = scenario('2026-09-25T19:15:00Z');
    assert.equal((await launchPaper(late.options)).status, 'completed');
    assert.equal(late.runs[0].durationMs, 15 * 60_000);
    assert.equal(late.runs[0].stopAtMs, Date.parse('2026-09-25T19:30:00Z'), 'provider startup cannot extend the absolute entry deadline');
    const lastSecond = scenario('2026-09-25T19:29:59.999Z');
    assert.equal((await launchPaper(lastSecond.options)).status, 'completed');
    assert.equal(lastSecond.runs[0].durationMs, 1);
    const cutoff = scenario('2026-09-25T19:30:00Z');
    assert.equal((await launchPaper(cutoff.options)).reason, 'entry-cutoff');
    assert.equal(cutoff.runs.length, 0);
    const after = scenario('2026-09-25T19:30:01Z');
    assert.equal((await launchPaper(after.options)).reason, 'entry-cutoff');
    assert.equal(after.runs.length, 0);
    const today = scenario('2026-09-24T13:30:00Z');
    assert.equal((await launchPaper(today.options)).reason, 'before-enabled-date');
    assert.equal(today.runs.length, 0);

    const winter = scenario('2026-11-02T14:28:00Z');
    assert.equal((await launchPaper(winter.options)).status, 'completed');
    assert.equal(winter.runs[0].at, Date.parse('2026-11-02T14:30:00Z'));
    assert.equal(winter.runs[0].durationMs, 6 * 60 * 60_000);
    const earlyClose = scenario('2026-09-25T15:00:00Z', { calendar: mockCalendar('12:00') });
    assert.equal((await launchPaper(earlyClose.options)).status, 'completed');
    assert.equal(earlyClose.runs[0].durationMs, 60 * 60_000);
    assert.equal(earlyClose.runs[0].stopAtMs, Date.parse('2026-09-25T16:00:00Z'));
    const earlyOpen = scenario('2026-09-25T12:58:00Z', { calendar: async (date) => [{ date, open: `${date}T13:00:00Z`, close: `${date}T20:00:00Z` }] });
    assert.equal((await launchPaper(earlyOpen.options)).status, 'completed');
    assert.equal(earlyOpen.runs[0].at, Date.parse('2026-09-25T13:00:00Z'));
    assert.equal(earlyOpen.runs[0].durationMs, 6.5 * 60 * 60_000);
    const sleepPastCutoff = scenario('2026-09-25T13:28:00Z');
    // Inject the clock itself, so a suspended host does not get a stale entry duration.
    let suspendedNow = Date.parse('2026-09-25T13:28:00Z');
    sleepPastCutoff.options.now = () => suspendedNow;
    sleepPastCutoff.options.sleep = async () => { suspendedNow = Date.parse('2026-09-25T19:30:00Z'); };
    assert.equal((await launchPaper(sleepPastCutoff.options)).reason, 'entry-cutoff');
    assert.equal(sleepPastCutoff.runs.length, 0);

    const failed = scenario('2026-09-25T13:30:00Z', { run: async () => { throw new Error('MOCK_START_FAILED'); } });
    await assert.rejects(launchPaper(failed.options), /MOCK_START_FAILED/);
    assert.equal((await launchPaper(failed.options)).reason, 'already-started');
    const calendarFailure = scenario('2026-09-25T13:28:00Z', { calendar: async () => { throw new Error('MOCK_CALENDAR_FAILED'); } });
    await assert.rejects(launchPaper(calendarFailure.options), /MOCK_CALENDAR_FAILED/);
    assert.equal(calendarFailure.runs.length, 0);
    calendarFailure.options.calendar = mockCalendar();
    assert.equal((await launchPaper(calendarFailure.options)).status, 'completed');

    const concurrent = scenario('2026-09-25T13:30:00Z');
    const pair = await Promise.all([launchPaper(concurrent.options), launchPaper(concurrent.options)]);
    assert.deepEqual(pair.map((item) => item.status).sort(), ['completed', 'skipped']);
    assert.equal(concurrent.runs.length, 1);
    const ledger = join(directory, 'ledger.log');
    await writeFile(ledger, '[x] DAY_START date=2026-09-25 ledgerId=v5-day-2026-09-25\n');
    assert.equal(await ledgerStarted('2026-09-25', ledger), true);
    assert.equal(await ledgerStarted('2026-09-26', ledger), false);
    assert.equal(await ledgerStarted('2026-09-25', join(directory, 'missing.log')), false);
    return { passed: true, brokerCalls: 0, cases: 'open, duplicate, active process, prior ledger, holiday, late wake, cutoff, enabled date, DST, early close, suspended host, failed startup, calendar failure, concurrent claim' };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await demo()));
