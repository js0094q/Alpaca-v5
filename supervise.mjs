// Restarts a crashed V5 run for the same Eastern trading date only.
// Usage: node supervise.mjs --mode=live --stop-at=12:00 --flatten-at=15:45
// A clean exit (code 0), an operator stop (SIGINT/SIGTERM), a new Eastern date,
// a non-transient startup error, or too many restarts ends supervision.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const MAX_RESTARTS = 10;
const BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 30_000];
// Errors a restart cannot fix; an operator must act first.
export const NON_TRANSIENT = new Set([
  'CREDENTIAL_UNAVAILABLE', 'LIVE_ENDPOINT_MISMATCH', 'LIVE_ACCOUNT_ID_INVALID', 'LIVE_ACCOUNT_NOT_ACTIVE',
  'LIVE_ACCOUNT_BLOCKED', 'LIVE_CREDENTIAL_OVERRIDE_FORBIDDEN', 'LIVE_FLATTEN_SESSION_UNKNOWN', 'PAPER_TRADE_AUTHORITY_LOCKED',
  'MANUAL_OWNERSHIP_UNRESOLVED', 'MANUAL_MARKER_UNKNOWN', 'ERR_INVALID_ARG_VALUE',
]);

export const dateET = (ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

export function restartDecision({ exitCode, signal = null, errorCode = null, errorName = null, stopping, launchDate, currentDate, restarts, maxRestarts = MAX_RESTARTS }) {
  if (stopping) return { restart: false, reason: 'operator_stop' };
  if (exitCode === 0 && !signal) return { restart: false, reason: 'clean_exit' };
  if (currentDate !== launchDate) return { restart: false, reason: 'trading_date_changed' };
  if (errorCode && NON_TRANSIENT.has(errorCode)) return { restart: false, reason: 'non_transient_error', errorCode };
  if (errorName === 'RangeError' || (errorName === 'TypeError' && !errorCode)) return { restart: false, reason: 'invalid_arguments' };
  if (restarts >= maxRestarts) return { restart: false, reason: 'restart_limit' };
  return { restart: true, delayMs: BACKOFF_MS[Math.min(restarts, BACKOFF_MS.length - 1)] };
}

const log = (event, fields = {}) => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), source: 'supervisor', event, ...fields })}\n`);

export async function supervise(args, { spawnChild = (childArgs) => spawn(process.execPath, [join(ROOT, 'paper.mjs'), ...childArgs], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] }), now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), signalSource = process } = {}) {
  const launchDate = dateET(now());
  let restarts = 0;
  let stopping = false;
  let child = null;
  const stop = (name) => { stopping = true; log('operator_stop', { signal: name }); child?.kill(name); };
  const onTerm = () => stop('SIGTERM');
  const onInt = () => stop('SIGINT');
  signalSource.on('SIGTERM', onTerm);
  signalSource.on('SIGINT', onInt);
  try {
    for (;;) {
      log('start', { attempt: restarts, launchDate, args });
      child = spawnChild(args);
      let outputRemainder = '';
      let lastLine = '';
      child.stdout?.on('data', (chunk) => {
        process.stdout.write(chunk);
        const lines = (outputRemainder + String(chunk)).split(/\r?\n/u);
        outputRemainder = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) lastLine = line.trim();
      });
      const { exitCode, signal, spawnError } = await new Promise((resolve) => {
        let settled = false;
        const finish = (result) => { if (settled) return; settled = true; resolve(result); };
        child.once('close', (code, sig) => finish({ exitCode: code, signal: sig }));
        child.once('error', (error) => finish({ exitCode: 1, signal: null, spawnError: error }));
      });
      if (outputRemainder.trim()) lastLine = outputRemainder.trim();
      let errorCode = null, errorName = null;
      try { const parsed = JSON.parse(lastLine); errorCode = parsed?.code ?? null; errorName = parsed?.name ?? null; } catch {}
      if (spawnError) { errorCode = spawnError.code ?? errorCode; errorName = spawnError.name ?? errorName; }
      child = null;
      const decision = restartDecision({ exitCode, signal, errorCode, errorName, stopping, launchDate, currentDate: dateET(now()), restarts });
      log('child_exit', { exitCode, signal, errorCode, ...decision });
      if (!decision.restart) return { ...decision, exitCode, restarts };
      restarts += 1;
      await sleep(decision.delayMs);
      if (stopping) return { restart: false, reason: 'operator_stop', restarts };
      if (dateET(now()) !== launchDate) return { restart: false, reason: 'trading_date_changed', restarts };
    }
  } finally {
    signalSource.off('SIGTERM', onTerm);
    signalSource.off('SIGINT', onInt);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await supervise(process.argv.slice(2));
  process.exitCode = result.reason === 'clean_exit' || result.reason === 'operator_stop' ? 0 : 1;
}
