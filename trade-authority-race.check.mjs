import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireTradeAuthority } from './trade-authority.mjs';

const directory = await mkdtemp(join(tmpdir(), 'v5-authority-race-'));
const lockPath = join(directory, 'authority.lock');
const stalePid = 999999;

try {
  await writeFile(lockPath, `${JSON.stringify({ pid: stalePid, role: 'v5-paper', token: 'stale', acquiredAt: '2026-01-01T00:00:00.000Z' })}\n`);
  const attempts = await Promise.allSettled(Array.from({ length: 16 }, () =>
    acquireTradeAuthority('v5-paper', { lockPath, isProcessGone: (pid) => pid === stalePid })));

  const acquired = attempts.filter((attempt) => attempt.status === 'fulfilled');
  const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
  assert.equal(acquired.length, 1, 'only one contender acquires authority after stale-lock recovery');
  assert.equal(rejected.length, 15);
  assert.ok(rejected.every(({ reason }) => reason.code === 'PAPER_TRADE_AUTHORITY_LOCKED'), 'losers fail closed');

  const owner = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.role, 'v5-paper');
  assert.equal((await readdir(directory)).filter((name) => name.startsWith('authority.lock.stale-')).length, 1);
  await acquired[0].value();
  await assert.rejects(readFile(lockPath, 'utf8'), { code: 'ENOENT' }, 'release removes only the winner lock');
  await assert.rejects(readFile(`${lockPath}.reclaim`, 'utf8'), { code: 'ENOENT' }, 'reclaim guard is released');
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('stale authority reclaim race: one winner, fifteen fail-closed');
