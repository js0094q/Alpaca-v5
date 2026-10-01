import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createCalendar } from './providers.mjs';
import { runPaper } from './paper.mjs';
import { loadCloseoutCredentials, loadModeAccountPaths, loadPaperAccountPaths } from './paper-account.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATE = join(ROOT, 'state', 'paper-launch-status');
const ENTRY_CUTOFF_MINUTE_ET = 15 * 60 + 30;
const exec = promisify(execFile);
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dateET = (ms) => dateFormatter.format(ms);
const minuteET = (ms) => { const [hour, minute] = timeFormatter.format(ms).split(':').map(Number); return hour * 60 + minute; };
const exists = async (path) => { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

export async function ledgerStarted(date, ledgerPath = join(ROOT, 'state', 'paper-ledger.log')) {
  if (!await exists(ledgerPath)) return false;
  const input = createReadStream(ledgerPath);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) if (line.includes('] DAY_START ') && line.includes(`date=${date} `)) return true;
    return false;
  } finally { lines.close(); input.destroy(); }
}

const processCwd = async (pid) => {
  try {
    const { stdout } = await exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 3000, maxBuffer: 64 * 1024 });
    return stdout.split('\n').find((line) => line.startsWith('n'))?.slice(1);
  } catch (error) {
    if (error.code !== 1) throw error;
    try { process.kill(pid, 0); throw new Error('PROCESS_CWD_UNAVAILABLE'); }
    catch (gone) { if (gone.code !== 'ESRCH') throw gone; }
  }
};

const entrySource = async (path) => {
  let file;
  try {
    file = await open(path, 'r');
    const bytes = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return bytes.toString('utf8', 0, bytesRead);
  } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  finally { await file?.close(); }
};

export async function activeV5({ processList, cwdFor = processCwd, sourceFor = entrySource } = {}) {
  const stdout = processList ?? (await exec('/bin/ps', ['-axo', 'pid=,command='], { timeout: 3000, maxBuffer: 2 * 1024 * 1024 })).stdout;
  const importsPaper = (source, base) => /\brunPaper\b/.test(source) && (source.includes(`${ROOT}/paper.mjs`) || (base === ROOT && /['"]\.\/paper\.mjs['"]/.test(source)));
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\S+)(.*)$/);
    if (!match || Number(match[1]) === process.pid || !/(?:^|\/)node(?:js)?$/.test(match[2])) continue;
    const args = match[3].trim();
    if (/(?:^|\s)(?:-e|--eval|-p|--print)(?:\s|=)/.test(args)) {
      if (importsPaper(args, await cwdFor(Number(match[1])))) return true;
      continue;
    }
    const tokens = args.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    const paths = tokens.map((token) => token.replace(/^(['"])(.*)\1$/, '$2'));
    if (paths.includes(join(ROOT, 'alpaca-bot-bridge', 'runtime.mjs')) && args.includes('--run-bot')) return true;
    if (paths.some((path) => [join(ROOT, 'paper.mjs'), join(ROOT, 'market-open.mjs')].includes(path))) return true;
    if (paths.some((path) => ['paper.mjs', './paper.mjs', 'market-open.mjs', './market-open.mjs'].includes(path)) && await cwdFor(Number(match[1])) === ROOT) return true;
    const script = tokens.find((token) => !token.startsWith('-'))?.replace(/^(['"])(.*)\1$/, '$2');
    // Stdin has no inspectable script; an opaque Node stdin session in this checkout is reserved.
    if (!script) { if (await cwdFor(Number(match[1])) === ROOT) return true; continue; }
    const path = isAbsolute(script) ? script : resolve(await cwdFor(Number(match[1])) ?? '/', script);
    if ([join(ROOT, 'paper.mjs'), join(ROOT, 'market-open.mjs')].includes(path)) return true;
    if (/\.[cm]?js$/.test(path) && importsPaper(await sourceFor(path), dirname(path))) return true;
  }
  return false;
}

async function calendarFor(date, { mode, credentials, baseUrl } = {}) {
  if (!['paper', 'live'].includes(mode)) throw new TypeError('mode must be paper or live');
  const account = credentials ?? (mode === 'paper' ? await loadCloseoutCredentials() : null);
  if (!account) throw new Error('MODE_CREDENTIALS_REQUIRED');
  const url = baseUrl ?? (mode === 'paper' ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets');
  const calendar = createCalendar({ key: account.key, secret: account.secret, baseUrl: url, fetchImpl: (requestUrl, options = {}) => {
    if (new URL(requestUrl).origin !== url || (options.method ?? 'GET') !== 'GET') throw new Error('CALENDAR_GET_ONLY');
    return fetch(requestUrl, { ...options, signal: AbortSignal.timeout(5000) });
  } });
  return calendar.loadCalendar({ start: date, end: date });
}

export async function launchMarketOpen({ mode, credentials, baseUrl, resume = false, signal, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  calendar = calendarFor, active = activeV5, started, run = runPaper, stateDirectory,
  accountPaths = async () => mode === 'paper' && !credentials
    ? loadPaperAccountPaths(await loadCloseoutCredentials())
    : loadModeAccountPaths(mode, credentials, baseUrl) } = {}) {
  if (!['paper', 'live'].includes(mode)) throw new TypeError('mode must be paper or live');
  if (mode === 'live' && !credentials) throw new Error('MODE_CREDENTIALS_REQUIRED');
  const date = dateET(now());
  const skip = (reason) => ({ status: 'skipped', reason, date });
  if (date < '2026-09-25') return skip('before-enabled-date');
  if (minuteET(now()) >= ENTRY_CUTOFF_MINUTE_ET) return skip('entry-cutoff');
  if (!stateDirectory) {
    const paths = await accountPaths();
    stateDirectory = paths.marketOpen;
    started ??= (date) => ledgerStarted(date, paths.ledger);
  }
  started ??= ledgerStarted;
  const claimPath = join(stateDirectory, resume ? `${date}.bridge-${process.pid}.claim` : `${date}.claim`);
  if (!resume && (await exists(claimPath) || await started(date))) return skip('already-started');
  if (await active()) return skip('active-v5');
  const row = (await calendar(date, { mode, credentials, baseUrl })).find((item) => item.date === date);
  if (!row) return skip('closed-date');
  const marketOpen = Date.parse(row.open), marketClose = Date.parse(row.close);
  if (!Number.isFinite(marketOpen) || !Number.isFinite(marketClose) || marketClose <= marketOpen || dateET(marketOpen) !== date || dateET(marketClose) !== date) throw new Error('INVALID_CALENDAR');
  // Calendar timestamps already include the actual Eastern UTC offset, including DST.
  const cutoff = Math.min(marketClose, marketOpen + (ENTRY_CUTOFF_MINUTE_ET - minuteET(marketOpen)) * 60_000);
  if (now() >= cutoff) return skip('entry-cutoff');
  await mkdir(stateDirectory, { recursive: true });
  while (now() < marketOpen && dateET(now()) === date && !signal?.aborted) {
    const duration = Math.min(60_000, marketOpen - now());
    if (!signal) await sleep(duration);
    else await new Promise((resolveWait) => {
      const timer = setTimeout(done, duration);
      function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolveWait(); }
      signal.addEventListener('abort', done, { once: true });
    });
  }
  if (signal?.aborted) return skip('stopped');
  if (dateET(now()) !== date || now() >= cutoff) return skip('entry-cutoff');
  if (await active()) return skip('active-v5');
  if (!resume && await started(date)) return skip('already-started');
  if (dateET(now()) !== date || now() < marketOpen || now() >= cutoff) return skip('outside-entry-window');
  let claim;
  try { claim = await open(claimPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return skip('already-started'); throw error; }
  const claimRecord = { date, mode, pid: process.pid, marketOpen: row.open, cutoff: new Date(cutoff).toISOString(), claimedAt: new Date(now()).toISOString() };
  try { await claim.writeFile(JSON.stringify(claimRecord)); await claim.sync(); } finally { await claim.close(); }
  const directory = await open(stateDirectory, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  // Never remove the claim, even if startup fails; an operator reviews any failed day.
  const invokedAt = now();
  if (dateET(invokedAt) !== date || invokedAt < marketOpen || invokedAt >= cutoff) return skip('claimed-outside-entry-window');
  const result = await run({ mode, ...(credentials ? { credentials } : {}), durationMs: cutoff - invokedAt, stopAtMs: cutoff, untilClose: false, ...(signal ? { signal } : {}) });
  return { status: 'completed', ...claimRecord, invokedAt: new Date(invokedAt).toISOString(), startDelayMs: invokedAt - marketOpen, completedAt: new Date(now()).toISOString(), runtimeState: result?.runtime?.state };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const result = await launchMarketOpen({ mode: 'paper', resume: process.argv.includes('--resume'), signal: controller.signal });
    if (result.status !== 'skipped') {
      await mkdir(STATE, { recursive: true });
      await writeFile(join(STATE, 'last-result.json'), `${JSON.stringify(result)}\n`, { mode: 0o600 });
    }
  } catch (error) {
    await mkdir(STATE, { recursive: true });
    await writeFile(join(STATE, 'last-result.json'), `${JSON.stringify({ status: 'failed', at: new Date().toISOString(), error: error.code ?? error.name })}\n`, { mode: 0o600 });
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
