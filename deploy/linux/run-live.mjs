import { readlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const exec = promisify(execFile);

async function linuxProcessList() {
  const { stdout } = await exec('ps', ['-u', String(process.getuid()), '-o', 'pid=,command='], { timeout: 3000, maxBuffer: 2 * 1024 * 1024 });
  return stdout;
}

async function linuxProcessCwd(pid) {
  try {
    return await readlink(`/proc/${pid}/cwd`);
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM', 'ESRCH'].includes(error.code)) return undefined;
    throw error;
  }
}

export async function runLive({ launch = null, credentialsLoader = null, activeCheck = null, runPaperImpl = null, signal = null } = {}) {
  const paperAccount = credentialsLoader ? null : await import('../../paper-account.mjs');
  const marketOpen = launch && activeCheck ? null : await import('../../market-open.mjs');
  const load = credentialsLoader ?? (typeof paperAccount.loadModeCredentials === 'function'
    ? () => paperAccount.loadModeCredentials('live')
    : null);
  if (!load) throw new Error('LIVE_CREDENTIAL_LOADER_UNAVAILABLE');
  const start = launch ?? marketOpen.launchMarketOpen;
  const checkActive = activeCheck ?? (async () => marketOpen.activeV5({ processList: await linuxProcessList(), cwdFor: linuxProcessCwd }));
  const runPaper = runPaperImpl ?? (await import('../../paper.mjs')).runPaper;
  const credentials = await load();
  return start({ mode: 'live', credentials, active: checkActive, run: createLiveRunAdapter(runPaper), ...(signal ? { signal } : {}) });
}

export function createLiveRunAdapter(runPaperImpl) {
  if (typeof runPaperImpl !== 'function') throw new TypeError('runPaper implementation is required');
  return ({ mode, credentials: _calendarCredentials, ...options }) => {
    if (mode !== 'live') throw new TypeError('Linux deployment adapter only accepts LIVE mode');
    return runPaperImpl({ mode, ...options });
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const result = await runLive({ signal: controller.signal });
    if (result.status !== 'skipped') {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const output = join(ROOT, 'state', 'live-launch-status');
      await mkdir(output, { recursive: true, mode: 0o700 });
      await writeFile(join(output, 'last-result.json'), `${JSON.stringify(result)}\n`, { mode: 0o600 });
    }
  } catch (error) {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const output = join(ROOT, 'state', 'live-launch-status');
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(join(output, 'last-result.json'), `${JSON.stringify({ status: 'failed', at: new Date().toISOString(), error: error.code ?? error.name })}\n`, { mode: 0o600 });
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
