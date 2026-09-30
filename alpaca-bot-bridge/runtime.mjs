import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, open, readFile, readdir, realpath, stat, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { request as paperRequest } from './broker.mjs';
import { activeV5 } from '../market-open.mjs';
import { createContinuity } from '../continuity.mjs';

const execFile = promisify(execFileCb);
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
const ROOT = REPO_ROOT;
const STATE = join(ROOT, 'state');
export const TRADE_AUTHORITY_LOCK = join(STATE, 'v5-trade-authority.lock');
const LAUNCH_LABEL = 'com.josephstew.v5-market-open';
const LEGACY_PAPER_PLIST = join(process.env.HOME ?? '', 'Library', 'LaunchAgents', `${LAUNCH_LABEL}.plist`);
const MAX_READ_BYTES = 32 * 1024;
const MAX_LOG_BYTES = 128 * 1024;
const MAX_RESULTS = 200;
const MAX_HISTORY_FILES = 5;
const ALLOWED_EXTENSIONS = new Set(['.mjs', '.js', '.json', '.md', '.plist', '.txt']);

export function requireMode(mode) {
  if (mode !== 'paper') throw new TypeError('this bridge runtime is PAPER only');
  return mode;
}

const safeNumber = (value, fallback, min, max) => Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
const within = (base, candidate) => candidate === base || candidate.startsWith(`${base}${sep}`);

export function processIdentity(command) {
  if (typeof command !== 'string') return null;
  const isScript = (path) => new RegExp(`(?:^|\\s|["'])${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|["']|$)`).test(command);
  const runner = isScript(join(HERE, 'runtime.mjs')) && /--run-bot\s+(?:paper|live)\b/.test(command);
  const entrypoint = runner ? 'runtime.mjs' : isScript(join(ROOT, 'market-open.mjs')) ? 'market-open.mjs' : isScript(join(ROOT, 'paper.mjs')) ? 'paper.mjs' : null;
  if (!entrypoint) return null;
  const explicit = (runner ? /--run-bot\s+(paper|live)\b/.exec(command)?.[1] : null) ?? /--mode(?:=|\s+)(paper|live)\b/.exec(command)?.[1];
  const mode = explicit ?? (entrypoint === 'market-open.mjs' || !/--mode/.test(command) ? 'paper' : null);
  return mode ? { mode, entrypoint, process: runner ? 'bridge-managed' : 'direct-v5' } : null;
}

export function stopTarget(mode, status) {
  requireMode(mode);
  return status?.mode === mode && status?.running === true && Number.isInteger(status?.pid) ? status.pid : null;
}

const modeConfig = async () => import('./config.mjs');

const boundedText = async (path, maxBytes) => {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    const handle = await open(path, 'r');
    try {
      const size = Math.min(maxBytes, info.size);
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, Math.max(0, info.size - size));
      return buffer.toString('utf8');
    } finally { await handle.close(); }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

const tailLines = (text, limit = 100) => String(text ?? '').split(/\r?\n/).filter(Boolean).slice(-limit);
const boundedLines = (text, limit = MAX_RESULTS) => {
  const lines = String(text ?? '').split(/\r?\n/).filter(Boolean);
  return { events: lines.slice(-limit), truncated: lines.length > limit };
};

export async function localSnapshot(mode = 'paper', postExitOptions = {}) {
  requireMode(mode);
  const capturedAt = new Date().toISOString();
  const unknown = (status = 'unavailable') => ({ mode, capturedAt, accountHash: null,
    provenance: { currentState: `mode_scoped_${mode}_account_hash`, historicalTelemetry: 'global_legacy_trace_account_unverified' },
    continuity: { status, trades: [] }, ledger: { status, events: [], truncated: false },
    telemetry: { status: 'unavailable', files: [] },
    postExitEvidence: { status: 'unavailable', provenance: `mode_scoped_${mode}_account_hash`, accountHash: null, filesAvailable: null, filesRead: 0, truncated: null, windows: [] },
    entry: { status: 'unavailable', orderId: null, clientOrderId: null } });
  try {
    const config = await modeConfig();
    const response = await paperRequest('/v2/account');
    if (!response.ok) return unknown(`account_http_${response.status ?? response.error?.code ?? 'unavailable'}`);
    const account = response.data;
    const { modeAccountPaths } = await import('../paper-account.mjs');
    const paths = modeAccountPaths(mode, account);
    const [positionsResponse, openOrdersResponse, ordersResponse, fillsResponse] = await Promise.all([
      paperRequest('/v2/positions'),
      paperRequest('/v2/orders?status=open&limit=500&direction=desc&nested=true'),
      paperRequest('/v2/orders?status=all&limit=500&direction=desc&nested=true'),
      paperRequest('/v2/account/activities/FILL?page_size=100&direction=desc'),
    ]);
    const broker = {
      status: positionsResponse.ok && openOrdersResponse.ok && ordersResponse.ok && fillsResponse.ok ? 'available' : 'partial',
      positions: positionsResponse.ok && Array.isArray(positionsResponse.data) ? positionsResponse.data : null,
      openOrders: openOrdersResponse.ok && Array.isArray(openOrdersResponse.data) ? openOrdersResponse.data : null,
      orders: ordersResponse.ok && Array.isArray(ordersResponse.data) ? ordersResponse.data : null,
      fills: fillsResponse.ok && Array.isArray(fillsResponse.data) ? fillsResponse.data : null,
      failures: Object.fromEntries([['positions', positionsResponse], ['openOrders', openOrdersResponse], ['orders', ordersResponse], ['fills', fillsResponse]]
        .filter(([, result]) => !result.ok).map(([name, result]) => [name, result.error?.code ?? `http_${result.status ?? 'unknown'}`])),
      ordersMayBeTruncated: ordersResponse.ok && ordersResponse.data?.length === 500,
      fillsMayBeTruncated: fillsResponse.ok && fillsResponse.data?.length === 100,
    };
    const loadedContinuity = createContinuity({ path: paths.continuity }).load();
    const continuityInfo = await stat(paths.continuity).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    const continuity = { status: loadedContinuity.status === 'compatible' ? 'available' : loadedContinuity.status,
      source: 'retained_local_state_file', authority: 'local_reporting_only', sourcePath: paths.continuity,
      sourceModifiedAt: continuityInfo?.mtime.toISOString() ?? null, trades: loadedContinuity.trades };
    const ownedPositions = loadedContinuity.status === 'compatible' ? joinOwnedPositions(loadedContinuity.trades, broker) : [];
    const activeBuyOrders = broker.openOrders?.filter((order) => order.side === 'buy' &&
      String(order.client_order_id ?? order.clientOrderId ?? '').startsWith('v5-buy-')) ?? null;
    const ledgerInfo = await stat(paths.ledger).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    const ledgerText = await boundedText(paths.ledger, MAX_LOG_BYTES);
    const ledgerTail = boundedLines(config.redact(ledgerText ?? ''));
    const ledger = { status: ledgerText === null ? 'missing' : 'available', events: ledgerTail.events,
      truncated: Boolean(ledgerInfo && ledgerInfo.size > MAX_LOG_BYTES) || ledgerTail.truncated, bytesRead: ledgerText === null ? 0 : Buffer.byteLength(ledgerText) };
    const telemetryDirectory = join(paths.directory, 'telemetry');
    const telemetry = { status: 'available', files: [], historicalPaper: null };
    try {
      const names = (await readdir(telemetryDirectory)).filter((item) => item.endsWith('.jsonl')).sort().slice(-10);
      for (const name of names) {
        const full = join(telemetryDirectory, name), info = await stat(full), content = await boundedText(full, MAX_LOG_BYTES);
        const eventTail = boundedLines(config.redact(content ?? ''));
        telemetry.files.push({ name, events: eventTail.events, truncated: info.size > MAX_LOG_BYTES || eventTail.truncated, bytesRead: Buffer.byteLength(content ?? '') });
      }
    } catch (error) { if (error.code === 'ENOENT') telemetry.status = 'missing'; else telemetry.status = 'unavailable'; }
    const postExitEvidence = await readPostExitEvidence(paths, mode,
      safeNumber(postExitOptions.limit, 50, 1, MAX_RESULTS), safeNumber(postExitOptions.offset, 0, 0, Number.MAX_SAFE_INTEGER), postExitOptions.file);
    const sessionArtifacts = { status: 'missing', claims: [], lastResult: null };
    try {
      const names = (await readdir(paths.marketOpen)).filter((name) => /^\d{4}-\d{2}-\d{2}(?:\.bridge-\d+)?\.claim$/.test(name)).sort();
      for (const name of names.slice(-20)) {
        try {
          const claim = JSON.parse(await boundedText(join(paths.marketOpen, name), 8 * 1024));
          sessionArtifacts.claims.push({ date: claim.date ?? name.slice(0, 10), mode: claim.mode ?? 'paper_legacy', marketOpen: claim.marketOpen ?? null, cutoff: claim.cutoff ?? null, claimedAt: claim.claimedAt ?? null });
        } catch {}
      }
      sessionArtifacts.status = names.length ? 'available' : 'missing';
      const resultPath = mode === 'paper' ? join(STATE, 'paper-launch-status', 'last-result.json') : null;
      const resultText = resultPath ? await boundedText(resultPath, 8 * 1024) : null;
      if (resultText) {
        const result = JSON.parse(resultText);
        sessionArtifacts.lastResult = { status: result.status ?? null, date: result.date ?? null, mode: 'paper_legacy', completedAt: result.completedAt ?? null, runtimeState: result.runtimeState ?? null };
        sessionArtifacts.status = 'available';
      }
    } catch (error) { sessionArtifacts.status = error.code === 'ENOENT' ? 'missing' : 'unavailable'; }
    return { mode, capturedAt, accountHash: paths.accountHash, provenance: { currentState: `mode_scoped_${mode}_account_hash`, historicalTelemetry: 'global_legacy_trace_account_unverified' }, continuity, ledger, telemetry, postExitEvidence,
      sessionArtifacts,
      broker, ownedPositions, activeBuyOrders,
      entry: { status: activeBuyOrders === null ? 'unknown' : activeBuyOrders.length ? 'active_buy_orders_observed' : 'none_observed', orders: activeBuyOrders } };
  } catch (error) { return unknown(error?.code ?? 'unavailable'); }
}

export function joinOwnedPositions(trades, broker) {
  return trades.map((trade) => {
    const localExecutionId = String(trade.executionId ?? '').toLowerCase();
    const fills = broker.fills?.filter((fill) => {
      const activityId = String(fill.id ?? fill.execution_id ?? '');
      const suffix = /::([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.exec(activityId)?.[1]?.toLowerCase();
      return (activityId.toLowerCase() === localExecutionId || suffix === localExecutionId) && fill.symbol === trade.symbol && fill.side === 'buy';
    }) ?? [];
    const entryFill = fills.length === 1 ? fills[0] : null;
    const entryOrders = entryFill ? broker.orders?.filter((order) => order.id === (entryFill.order_id ?? entryFill.orderId) && order.side === 'buy') ?? [] : [];
    const sells = broker.openOrders?.filter((order) => order.side === 'sell' && order.symbol === trade.symbol &&
      (order.id === trade.orderId || order.client_order_id === trade.logicalSellId || order.clientOrderId === trade.logicalSellId)) ?? [];
    return { ...trade,
      tradeSetId: entryOrders.length === 1 ? entryOrders[0].client_order_id ?? entryOrders[0].clientOrderId ?? trade.tradeSetId ?? null : trade.tradeSetId ?? null,
      entryFill, entryFillMatch: fills.length === 1 ? 'exact_execution_id' : fills.length > 1 ? 'ambiguous' : broker.fills ? 'not_in_recent_fill_page' : 'unknown',
      entryOrder: entryOrders.length === 1 ? entryOrders[0] : null,
      entryOrderMatch: entryOrders.length === 1 ? 'exact_order_id_and_buy_side' : entryOrders.length > 1 ? 'ambiguous' : broker.orders ? 'not_found' : 'unknown',
      sellOrder: sells.length === 1 ? sells[0] : null,
      sellOrderMatch: sells.length === 1 ? 'exact_order_or_client_order_id' : sells.length > 1 ? 'ambiguous' : broker.openOrders ? 'not_found' : 'unknown' };
  });
}

export async function readPostExitEvidence(paths, mode, limit, offset = 0, file) {
  requireMode(mode);
  const directory = join(paths.directory, 'post-exit-evidence');
  try {
    const files = await Promise.all((await readdir(directory)).filter((name) => /^post-exit-[a-f0-9]{64}\.jsonl$/.test(name))
      .map(async (name) => ({ name, modified: (await stat(join(directory, name))).mtimeMs })));
    const allNames = files.sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name)).map(({ name }) => name);
    if (file !== undefined && !/^post-exit-[a-f0-9]{64}\.jsonl$/.test(file)) throw new TypeError('file must be a post-exit evidence basename');
    const names = file ? allNames.filter((name) => name === file) : allNames.slice(-MAX_HISTORY_FILES);
    const windows = [];
    for (const name of names) {
      const full = join(directory, name), info = await stat(full), content = await boundedText(full, 512 * 1024);
      const rows = String(content ?? '').split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try { const row = JSON.parse(line); return row.fields?.mode === mode && row.fields?.accountHash === paths.accountHash ? [row] : []; } catch { return []; }
      });
      const counts = Object.fromEntries(['POST_EXIT_START', 'POST_EXIT_QUOTE', 'POST_EXIT_GAP', 'POST_EXIT_END'].map((event) => [event, rows.filter((row) => row.event === event).length]));
      const start = rows.find((row) => row.event === 'POST_EXIT_START');
      const end = [...rows].reverse().find((row) => row.event === 'POST_EXIT_END');
      const page = rows.slice(offset, offset + limit);
      windows.push({ file: name, sourceModifiedAt: info.mtime.toISOString(), mode, accountHash: paths.accountHash, tradeId: start?.fields?.tradeId ?? null,
        entrySetId: start?.fields?.entrySetId ?? null, entryExecutionId: start?.fields?.entryExecutionId ?? null,
        exitExecutionId: start?.fields?.exitExecutionId ?? null, symbol: start?.fields?.symbol ?? null,
        status: end?.fields?.status ?? (start ? 'incomplete_missing_end' : 'identity_unavailable'),
        coverage: { eventCounts: counts, startAt: start?.wallTimeMs ? new Date(start.wallTimeMs).toISOString() : null,
          endAt: end?.wallTimeMs ? new Date(end.wallTimeMs).toISOString() : null, truncated: info.size > 512 * 1024 },
        totalEvents: info.size > 512 * 1024 ? null : rows.length, offset, limit, returned: page.length,
        truncated: info.size > 512 * 1024 || offset + page.length < rows.length,
        nextOffset: offset + page.length < rows.length ? offset + page.length : null,
        events: page.map(({ schema, runId, sequence, wallTimeMs, event, fields }) => ({ schema, runId, sequence, wallTimeMs, event, fields })) });
    }
    return { status: names.length ? 'available' : 'missing', provenance: `mode_scoped_${mode}_account_hash`, accountHash: paths.accountHash,
      filesAvailable: allNames.length, candidateFiles: allNames, filesRead: names.length,
      truncated: (!file && allNames.length > names.length) || windows.some((window) => window.truncated || window.coverage.truncated), windows };
  } catch (error) { return { status: error.code === 'ENOENT' ? 'missing' : 'unavailable', provenance: `mode_scoped_${mode}_account_hash`, accountHash: paths.accountHash, filesAvailable: null, filesRead: 0, truncated: null, windows: [] }; }
}

async function bridgePidPath(mode) { requireMode(mode); return join(STATE, 'alpaca-bot-bridge', `${mode}.pid.json`); }

async function readPidRecord(mode) {
  try { return JSON.parse(await readFile(await bridgePidPath(mode), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

async function processLine(pid) {
  try {
    const { stdout } = await execFile('/bin/ps', ['-p', String(pid), '-o', 'pid=,command='], { timeout: 3000, maxBuffer: 16 * 1024 });
    return stdout.trim() || null;
  } catch (error) { if (error.code === 1) return null; throw error; }
}

async function livePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function launchAgentState() {
  try {
    const { stdout } = await execFile('/bin/launchctl', ['print', `gui/${process.getuid()}/${LAUNCH_LABEL}`], { timeout: 3000, maxBuffer: 128 * 1024 });
    return { loaded: true, running: /\bstate = running\b/.test(stdout), label: LAUNCH_LABEL, plist: LEGACY_PAPER_PLIST };
  } catch (error) {
    if (error.code === 113 || error.code === 3) return { loaded: false, running: false, label: LAUNCH_LABEL, plist: LEGACY_PAPER_PLIST };
    return { loaded: null, running: null, label: LAUNCH_LABEL, status: 'unavailable' };
  }
}

async function botStatus(mode = 'paper') {
  const record = await readPidRecord(mode);
  let command = record?.pid ? await processLine(record.pid) : null;
  const expected = record && command && command.includes(join(HERE, 'runtime.mjs')) && command.includes(`--run-bot ${mode}`);
  const agent = mode === 'paper' ? await launchAgentState() : null;
  const identityOk = Boolean(expected);
  let legacyProcesses = [];
  let processScan = 'available';
  let activeUnknown = false;
  try {
    const { stdout } = await execFile('/bin/ps', ['-axo', 'pid=,command='], { timeout: 3000, maxBuffer: 256 * 1024 });
    const nodeProcesses = stdout.split('\n');
    legacyProcesses = nodeProcesses.flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!match || Number(match[1]) === process.pid || !/(?:^|\s)(?:\/opt\/homebrew\/bin\/node|\/usr\/bin\/node|node)(?:\s|$)/.test(match[2])) return [];
      const identity = processIdentity(match[2]);
      return identity?.mode === mode ? [{ pid: Number(match[1]), ...identity }] : [];
    });
    const unclassifiedLines = nodeProcesses.filter((line) => {
      const match = line.match(/^\s*\d+\s+(.*)$/);
      return !match || !processIdentity(match[1]) || processIdentity(match[1]).mode === mode;
    });
    if (!identityOk && !legacyProcesses.length) activeUnknown = await activeV5({ processList: unclassifiedLines.join('\n') });
  } catch { processScan = 'unavailable'; }
  const starting = Boolean(record?.launcherPid && !record?.pid && await livePid(record.launcherPid) && Date.now() - Date.parse(record.startedAt) < 15_000);
  const observedRunning = identityOk || starting || legacyProcesses.length > 0 || Boolean(agent?.running);
  const running = processScan === 'available' ? (observedRunning ? true : activeUnknown ? null : false) : observedRunning ? true : null;
  return { mode, running, pid: identityOk ? record.pid : legacyProcesses[0]?.pid ?? null,
    process: identityOk ? 'bridge-managed' : legacyProcesses[0]?.process ?? (agent?.running ? 'launch-agent' : starting ? 'starting' : null),
    legacyPaperLaunchAgent: agent, directProcesses: legacyProcesses, processScan, unclassifiedV5Active: activeUnknown,
    state: running === null ? 'unknown' : running ? (starting ? 'starting' : 'running') : record ? 'stale_or_unverifiable' : 'stopped' };
}

export async function assertBotStopped() {
  const status = await botStatus('paper');
  if (status.running !== false || status.legacyPaperLaunchAgent?.loaded === true && status.legacyPaperLaunchAgent?.running !== false) {
    throw Object.assign(new Error('PAPER V5 runtime is running or its state is unknown.'), { code: 'PAPER_BOT_NOT_STOPPED', status });
  }
  return status;
}

export async function acquireTradeAuthority(role = 'bridge-manual', { lockPath = TRADE_AUTHORITY_LOCK } = {}) {
  if (!['bridge-manual', 'v5-paper'].includes(role)) throw new TypeError('invalid trade authority role');
  const owner = JSON.stringify({ pid: process.pid, role, token: randomUUID(), acquiredAt: new Date().toISOString() });
  await mkdir(dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(`${owner}\n`, 'utf8');
  } catch (error) {
    await handle?.close().catch(() => {});
    if (handle) await unlink(lockPath).catch(() => {});
    if (error.code === 'EEXIST') {
      let existing = null;
      try { existing = JSON.parse(await readFile(lockPath, 'utf8')); } catch {}
      throw Object.assign(new Error('PAPER trade authority is already held or requires operator lock recovery.'), {
        code: 'PAPER_TRADE_AUTHORITY_LOCKED', owner: existing && { pid: existing.pid, role: existing.role, acquiredAt: existing.acquiredAt },
      });
    }
    throw error;
  }
  await handle.close();
  let released = false;
  return async () => {
    if (released) return false;
    released = true;
    try {
      if (await readFile(lockPath, 'utf8') !== `${owner}\n`) return false;
      await unlink(lockPath);
      return true;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
}

async function repoStatus() {
  const { stdout } = await execFile('/usr/bin/git', ['-C', ROOT, 'status', '--short', '--branch'], { timeout: 3000, maxBuffer: 256 * 1024 });
  return sanitizeRepoResult({ root: ROOT, status: stdout.slice(0, MAX_LOG_BYTES) });
}

async function repoDiff() {
  try {
    const { stdout } = await execFile('/usr/bin/git', ['-C', ROOT, 'diff', '--no-ext-diff', '--unified=2', 'HEAD', '--', '*.mjs', '*.js', '*.md'], { timeout: 5000, maxBuffer: MAX_LOG_BYTES });
    return sanitizeRepoResult({ diff: stdout.slice(0, MAX_LOG_BYTES), truncated: stdout.length > MAX_LOG_BYTES });
  } catch (error) {
    if (error.code !== 128) throw error;
    return sanitizeRepoResult({ diff: '', status: 'no_git_baseline', detail: 'No HEAD commit is available for a repository diff.' });
  }
}

async function sanitizeRepoResult(value) {
  const config = await import('./config.mjs');
  for (const mode of ['paper', 'live']) try { await config.resolveMode(mode); } catch {}
  return config.redact(value);
}

async function resolveRepoFile(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/).some((part) => part === '..' || part === '.')) throw new Error('INVALID_REPO_PATH');
  const full = resolve(ROOT, path);
  if (!within(ROOT, full) || !ALLOWED_EXTENSIONS.has(extname(full).toLowerCase()) || /(?:^|[\\/])(?:\.git|node_modules|state|telemetry-trace|\.env)(?:[\\/]|$)/i.test(path) || /(?:secret|credential|token|password|\.env)/i.test(path)) throw new Error('REPO_PATH_NOT_ALLOWED');
  const real = await realpath(full);
  if (!within(await realpath(ROOT), real)) throw new Error('REPO_PATH_NOT_ALLOWED');
  const info = await lstat(full);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_READ_BYTES) throw new Error('REPO_FILE_NOT_ALLOWED');
  return real;
}

async function repoRead(path) { const full = await resolveRepoFile(path); return sanitizeRepoResult({ path, content: await readFile(full, 'utf8') }); }

async function repoSearch(query, paths = ['.']) {
  if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('INVALID_SEARCH_QUERY');
  if (!Array.isArray(paths) || paths.length > 20) throw new Error('INVALID_SEARCH_PATHS');
  const allowed = [];
  for (const path of paths) {
    if (path === '.') { allowed.push('.'); continue; }
    allowed.push(relative(ROOT, await resolveRepoFile(path)));
  }
  const rgPath = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex-path/rg';
  const { stdout } = await execFile(rgPath, ['-n', '--no-heading', '--max-count', '100', '--glob', '*.mjs', '--glob', '*.js', '--glob', '*.json', '--glob', '*.md', '--glob', '*.plist', '--glob', '*.txt', '--glob', '!**/.git/**', '--glob', '!**/node_modules/**', '--glob', '!**/state/**', '--glob', '!**/telemetry-trace/**', '--glob', '!**/*.env', '--glob', '!**/*secret*', '--glob', '!**/*credential*', '--glob', '!**/*token*', '--glob', '!**/*password*', '--', query, ...allowed], { cwd: ROOT, timeout: 5000, maxBuffer: MAX_LOG_BYTES }).catch((error) => {
    if (error.code === 1) return { stdout: '' };
    throw error;
  });
  return sanitizeRepoResult({ results: stdout.split(/\r?\n/).filter(Boolean).slice(0, MAX_RESULTS), truncated: stdout.length >= MAX_LOG_BYTES });
}

async function logs(mode, limit) {
  const snapshot = await localSnapshot(mode);
  return { mode, limit, accountHash: snapshot.accountHash, provenance: snapshot.provenance,
    activeState: snapshot.continuity, ledger: { ...snapshot.ledger, events: snapshot.ledger.events.slice(-limit) },
    telemetry: snapshot.telemetry, postExitEvidence: snapshot.postExitEvidence };
}

async function recentTrades(mode, limit) {
  const snapshot = await localSnapshot(mode);
  const events = snapshot.ledger.events.map((line) => ({ accountHash: snapshot.accountHash, line }))
    .filter(({ line }) => /\b(?:FILL|EXIT)\b/.test(line)).slice(-limit);
  return { mode, capturedAt: snapshot.capturedAt, accountHash: snapshot.accountHash,
    sourceStatus: snapshot.ledger.status, truncated: snapshot.ledger.truncated, trades: events };
}

async function activeState(mode) {
  const [snapshot, process] = await Promise.all([localSnapshot(mode), botStatus(mode)]);
  return { mode, capturedAt: snapshot.capturedAt, accountHash: snapshot.accountHash, process,
    stateFile: snapshot.continuity, broker: snapshot.broker ?? { status: 'unavailable' },
    ownedPositions: snapshot.ownedPositions ?? [], activeBuyOrders: snapshot.activeBuyOrders ?? null,
    entry: snapshot.entry ?? { status: 'unknown', orders: null }, provenance: snapshot.provenance };
}

async function errors(mode, limit) {
  const snapshot = await localSnapshot(mode);
  const events = snapshot.telemetry.files.flatMap((file) => file.events.filter((line) => /(?:error|failure|issue)/i.test(line)).map((line) => ({ file: file.name, line }))).slice(-limit);
  return { mode, capturedAt: snapshot.capturedAt, accountHash: snapshot.accountHash, provenance: snapshot.provenance,
    status: snapshot.telemetry.status, sourceFiles: snapshot.telemetry.files.length, truncated: snapshot.telemetry.files.some((file) => file.truncated), events };
}

async function postExit(mode, args) {
  const snapshot = await localSnapshot(mode, args);
  return { mode, capturedAt: snapshot.capturedAt, accountHash: snapshot.accountHash, provenance: snapshot.postExitEvidence?.provenance,
    ...snapshot.postExitEvidence };
}

export async function readLocalHistory({ mode = 'paper', date, limit = 100, offset = 0, file, eventNames, tradeId, entrySetId, tradeSetId, runId } = {}) {
  requireMode(mode);
  if (mode !== 'paper') return { mode, status: 'excluded', reason: 'legacy_global_history_is_paper_only', events: [] };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new TypeError('date must be YYYY-MM-DD');
  limit = safeNumber(limit, 100, 1, MAX_RESULTS);
  offset = safeNumber(offset, 0, 0, Number.MAX_SAFE_INTEGER);
  if (file !== undefined && (typeof file !== 'string' || !/^v5-trace-\d{13}-[\w-]+\.jsonl$/.test(file))) throw new TypeError('file must be a trace basename');
  if (eventNames !== undefined && (!Array.isArray(eventNames) || eventNames.length > 30 || eventNames.some((event) => typeof event !== 'string' || event.length > 80))) throw new TypeError('eventNames must contain at most 30 event names');
  const localStart = (day) => {
    const probe = new Date(`${day}T12:00:00Z`);
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(probe).map(({ type, value }) => [type, value]));
    const localAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    const offset = localAsUtc - probe.getTime();
    return Date.parse(`${day}T00:00:00Z`) - offset;
  };
  const nextDay = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const start = localStart(date), end = localStart(nextDay);
  const directory = join(ROOT, 'telemetry-trace');
  const availableFiles = (await readdir(directory)).filter((name) => {
    const stamp = /^v5-trace-(\d{13})-/.exec(name)?.[1];
    return name.endsWith('.jsonl') && stamp && Number(stamp) >= start && Number(stamp) < end;
  }).sort();
  const names = (file ? availableFiles.filter((name) => name === file) : availableFiles.slice(0, MAX_HISTORY_FILES));
  const selectedEvents = eventNames ? new Set(eventNames) : null;
  const events = [];
  let matchingCount = 0, scannedRows = 0, firstSeen = null, lastSeen = null;
  for (const name of names) {
    const input = createInterface({ input: createReadStream(join(directory, name)), crlfDelay: Infinity });
    for await (const line of input) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      scannedRows++;
      if (typeof row.runId !== 'string' || typeof row.event !== 'string' || !Number.isFinite(row.wallTimeMs) || row.wallTimeMs < start || row.wallTimeMs >= end) continue;
      const fields = row.fields ?? {};
      firstSeen ??= new Date(row.wallTimeMs).toISOString();
      lastSeen = new Date(row.wallTimeMs).toISOString();
      if (selectedEvents && !selectedEvents.has(row.event) || tradeId && fields.tradeId !== tradeId ||
          entrySetId && fields.entrySetId !== entrySetId && fields.tradeSetId !== entrySetId ||
          tradeSetId && fields.tradeSetId !== tradeSetId && fields.entrySetId !== tradeSetId || runId && row.runId !== runId) continue;
      if (matchingCount >= offset && events.length < limit) events.push({ file: name, runId: row.runId, sequence: row.sequence ?? null, at: new Date(row.wallTimeMs).toISOString(), event: row.event, fields });
      matchingCount++;
    }
  }
  const pageEnd = offset + events.length;
  const scanTruncated = !file && availableFiles.length > names.length;
  const truncated = scanTruncated || pageEnd < matchingCount;
  const sessions = [...events.reduce((grouped, event) => {
    let session = grouped.get(event.runId);
    if (!session) grouped.set(event.runId, session = { runId: event.runId, files: [], events: [] });
    if (!session.files.includes(event.file)) session.files.push(event.file);
    session.events.push(event);
    return grouped;
  }, new Map()).values()];
  return { mode, date, capturedAt: new Date().toISOString(), provenance: 'legacy_global_paper_trace_account_unverified', status: names.length ? 'available' : 'missing',
    dateTimeZone: 'America/New_York', filesAvailable: availableFiles.length, filesScanned: names.length, candidateFiles: availableFiles,
    scanTruncated, scannedRows, firstSeen, lastSeen, offset, limit, returned: events.length,
    totalMatching: scanTruncated ? null : matchingCount, truncated, nextOffset: pageEnd < matchingCount ? pageEnd : null, events, sessions };
}

async function session(mode = 'paper') {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const response = await paperRequest(`/v2/calendar?start=${date}&end=${date}`);
  if (!response.ok) throw new Error(`CALENDAR_HTTP_${response.status ?? response.error?.code ?? 'unavailable'}`);
  const rows = response.data;
  const snapshot = await localSnapshot(mode);
  return { mode, date, capturedAt: snapshot.capturedAt, session: rows?.[0] ?? null,
    accountHash: snapshot.accountHash, provenance: snapshot.provenance, runtimeArtifacts: snapshot.sessionArtifacts,
    ledgerStatus: snapshot.ledger.status, ledgerEvents: snapshot.ledger.events.filter((line) => line.includes(`date=${date}`)).slice(-MAX_RESULTS) };
}

async function sessionSummary(mode) {
  const snapshot = await localSnapshot(mode);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const lines = snapshot.ledger.events.filter((line) => line.includes(`date=${date}`) || line.includes(`DAY_START date=${date}`)).map((line) => ({ accountHash: snapshot.accountHash, line }));
  const counts = { fills: lines.filter(({ line }) => /\bFILL\b/.test(line)).length, exits: lines.filter(({ line }) => /\bEXIT\b/.test(line)).length };
  return { mode, date, capturedAt: snapshot.capturedAt, accountHash: snapshot.accountHash, provenance: snapshot.provenance,
    sourceStatus: snapshot.ledger.status, truncated: snapshot.ledger.truncated,
    counts, events: lines.slice(-MAX_RESULTS), sessionArtifacts: snapshot.sessionArtifacts };
}

const input = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const modeSchema = input({});
const boundedModeSchema = input({ limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS } });
const historySchema = input({ date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, file: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS }, offset: { type: 'integer', minimum: 0 }, eventNames: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 80 } }, tradeId: { type: 'string', maxLength: 160 }, entrySetId: { type: 'string', maxLength: 160 }, tradeSetId: { type: 'string', maxLength: 160 }, runId: { type: 'string', maxLength: 160 } }, ['date']);
const postExitSchema = input({ file: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS }, offset: { type: 'integer', minimum: 0 } });
const repoPathSchema = input({ path: { type: 'string', minLength: 1, maxLength: 300 } }, ['path']);

export const tools = [
  { name: 'bot_status', description: 'Read the observed PAPER V5 process and scheduler status.', inputSchema: modeSchema, handler: async () => botStatus('paper') },
  { name: 'bot_active_state', description: 'Read PAPER broker state, active runtime lots, owned fills, latched SELL orders, and continuity state.', inputSchema: modeSchema, handler: async () => activeState('paper') },
  { name: 'bot_errors', description: 'Read bounded PAPER telemetry error, failure, and issue events.', inputSchema: boundedModeSchema, handler: async (args) => errors('paper', safeNumber(args.limit, 100, 1, MAX_RESULTS)) },
  { name: 'bot_post_exit_evidence', description: 'Read PAPER account-scoped retained post-exit evidence with coverage and paging.', inputSchema: postExitSchema, handler: async (args) => postExit('paper', args) },
  { name: 'bot_logs', description: 'Read bounded PAPER local telemetry and ledger logs.', inputSchema: boundedModeSchema, handler: async (args) => logs('paper', safeNumber(args.limit, 100, 1, MAX_RESULTS)) },
  { name: 'bot_session', description: 'Read today’s PAPER Alpaca calendar session.', inputSchema: modeSchema, handler: async () => session('paper') },
  { name: 'bot_recent_trades', description: 'Read recent PAPER local ledger fill and exit records.', inputSchema: boundedModeSchema, handler: async (args) => recentTrades('paper', safeNumber(args.limit, 100, 1, MAX_RESULTS)) },
  { name: 'bot_history', description: 'Read bounded historical PAPER trace events and exact trade, entry-set, run, and execution identifiers. Legacy traces have unverified account ownership.', inputSchema: historySchema, handler: async (args) => readLocalHistory({ ...args, mode: 'paper' }) },
  { name: 'bot_session_summary', description: 'Summarize today’s PAPER local ledger events.', inputSchema: modeSchema, handler: async () => sessionSummary('paper') },
  { name: 'repo_status', description: 'Read the V5 repository status.', inputSchema: input({}), handler: async () => repoStatus() },
  { name: 'repo_diff', description: 'Read a bounded V5 source and documentation diff.', inputSchema: input({}), handler: async () => repoDiff() },
  { name: 'repo_read', description: 'Read one bounded allowlisted V5 source or documentation file.', inputSchema: repoPathSchema, handler: async (args) => repoRead(args.path) },
  { name: 'repo_search', description: 'Search allowlisted V5 source and documentation files with bounded results.', inputSchema: input({ query: { type: 'string', minLength: 1, maxLength: 200 }, paths: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 300 } } }, ['query']), handler: async (args) => repoSearch(args.query, args.paths ?? ['.']) },
];
