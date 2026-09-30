import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAPER_ENV, paperAccountPaths, loadPaperAccountPaths } from './paper-account.mjs';
import { loadCloseoutCredentials } from './closeout.mjs';
import { launchMarketOpen } from './market-open.mjs';
import { createContinuity } from './continuity.mjs';

const directory = await mkdtemp(join(tmpdir(), 'v5-paper-account-'));
try {
  assert.equal(PAPER_ENV, join(homedir(), 'Documents', 'paper.env'));
  const env = join(directory, 'paper.env');
  await writeFile(env, 'APCA_API_KEY="test-key"\nAPCA_SECRET_KEY=test-secret\n');
  assert.deepEqual(await loadCloseoutCredentials(env), { key: 'test-key', secret: 'test-secret' });
  await assert.rejects(loadCloseoutCredentials(join(directory, 'missing')), { code: 'ENOENT' });
  await writeFile(env, 'APCA_API_KEY=test-key\n');
  await assert.rejects(loadCloseoutCredentials(env), /missing/);
  const first = paperAccountPaths({ id: 'account-one' }), second = paperAccountPaths({ id: 'account-two' });
  assert.deepEqual(first, paperAccountPaths({ id: 'account-one' }));
  assert.notEqual(first.directory, second.directory);
  assert.match(first.accountHash, /^[a-f0-9]{64}$/);
  for (const field of ['continuity', 'ledger', 'closeoutLedger', 'marketOpen']) assert.ok(first[field].startsWith(`${first.directory}/`));
  assert.throws(() => paperAccountPaths({}), /MISSING/);
  let requests = 0;
  const fetched = await loadPaperAccountPaths({ key: 'test-key', secret: 'test-secret' }, async (url, options) => {
    requests++;
    assert.equal(url, 'https://paper-api.alpaca.markets/v2/account');
    assert.equal(options.method ?? 'GET', 'GET');
    return { ok: true, json: async () => ({ id: 'account-one' }) };
  });
  assert.deepEqual(fetched, first);
  assert.equal(requests, 1);
  await assert.rejects(loadPaperAccountPaths({}, async () => ({ ok: false })), /LOOKUP_FAILED/);
  const legacy = join(directory, 'v5-active-state.json');
  await writeFile(legacy, 'preserved legacy continuity');
  const isolated = createContinuity({ path: join(directory, 'new-account', 'v5-active-state.json') });
  assert.equal(isolated.load().status, 'missing');
  isolated.clear();
  assert.equal(await readFile(legacy, 'utf8'), 'preserved legacy continuity');
  const paths = { marketOpen: join(directory, 'new-account', 'market-open'), ledger: join(directory, 'new-account', 'paper-ledger.log') };
  let runs = 0;
  const options = { now: () => Date.parse('2026-09-25T14:00:00Z'), accountPaths: async () => paths, active: async () => false,
    calendar: async () => [{ date: '2026-09-25', open: '2026-09-25T13:30:00Z', close: '2026-09-25T20:00:00Z' }],
    run: async () => { runs++; return { runtime: { state: 'MANAGING' } }; } };
  assert.equal((await launchMarketOpen({ mode: 'paper', ...options })).status, 'completed');
  assert.equal((await launchMarketOpen({ mode: 'paper', ...options })).reason, 'already-started');
  assert.equal(runs, 1);
  assert.equal(JSON.parse(await readFile(join(paths.marketOpen, '2026-09-25.claim'))).mode, 'paper');
  console.log(JSON.stringify({ passed: true, checks: 'durable credentials, no fallback, account isolation, GET-only identity, isolated continuity and launch claims', brokerCalls: 0 }));
} finally { await rm(directory, { recursive: true, force: true }); }
