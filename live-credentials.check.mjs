import assert from 'node:assert/strict';
import { LIVE_ENV, PAPER_ENV, loadModeCredentials, assertLiveAccount, loadModeAccountPaths } from './paper-account.mjs';
import { resolveMode, redact } from './alpaca-bot-bridge/config.mjs';
import { createAlpacaBroker } from './alpaca.mjs';

const liveText = 'export APCA_API_KEY="fixture-live-key"\nAPCA_SECRET_KEY=fixture-live-secret\n';
const liveAliasText = 'APCIA_API_Key="fixture-alias-key"\nAPCIA_SECRET_KEY=fixture-alias-secret\n';
const paperText = 'APCA_API_KEY=fixture-paper-key\nAPCA_SECRET_KEY=fixture-paper-secret\n';
const calls = [];
const readFileImpl = async (path) => {
  calls.push(path);
  if (path === LIVE_ENV) return liveText;
  if (path === PAPER_ENV) return paperText;
  throw Object.assign(new Error('fixture missing'), { code: 'ENOENT' });
};

assert.deepEqual(await loadModeCredentials('live', { readFileImpl }), { key: 'fixture-live-key', secret: 'fixture-live-secret' });
assert.deepEqual(calls, [LIVE_ENV]);
assert.deepEqual(await loadModeCredentials('live', { readFileImpl: async (path) => { assert.equal(path, LIVE_ENV); return liveAliasText; } }), { key: 'fixture-alias-key', secret: 'fixture-alias-secret' });
await assert.rejects(loadModeCredentials('live', { readFileImpl: async () => `${liveText}APCIA_API_Key=conflicting-alias\n` }), { code: 'CREDENTIAL_UNAVAILABLE' });
calls.length = 0;
assert.deepEqual(await loadModeCredentials('paper', { readFileImpl }), { key: 'fixture-paper-key', secret: 'fixture-paper-secret' });
assert.deepEqual(calls, [PAPER_ENV]);
calls.length = 0;
await assert.rejects(loadModeCredentials('live', { readFileImpl: async (path) => { calls.push(path); throw new Error('fixture'); } }), (error) => error.code === 'CREDENTIAL_UNAVAILABLE' && !error.message.includes('fixture-live-secret'));
assert.deepEqual(calls, [LIVE_ENV]);
await assert.rejects(loadModeCredentials('live', { readFileImpl: async () => 'APCA_API_KEY=only-key' }), { code: 'CREDENTIAL_UNAVAILABLE' });
await assert.rejects(loadModeCredentials('paper', { readFileImpl: async (path) => { assert.equal(path, PAPER_ENV); throw new Error('fixture'); } }), { code: 'CREDENTIAL_UNAVAILABLE' });

calls.length = 0;
const bridgeLive = await resolveMode('live', { readFileImpl });
assert.equal(bridgeLive.mode, 'live');
assert.equal(bridgeLive.baseUrl, 'https://api.alpaca.markets');
assert.deepEqual(calls, [LIVE_ENV]);
const bridgeAlias = await resolveMode('live', { readFileImpl: async (path) => { assert.equal(path, LIVE_ENV); return liveAliasText; } });
assert.deepEqual([bridgeAlias.apiKey, bridgeAlias.apiSecret], ['fixture-alias-key', 'fixture-alias-secret']);
assert.equal(redact('fixture-live-secret'), '[REDACTED]');
await assert.rejects(resolveMode('live', { readFileImpl: async () => 'APCA_API_KEY=bad\n' }), { code: 'CREDENTIAL_UNAVAILABLE' });
await assert.rejects(resolveMode('paper', { readFileImpl: async (path) => { assert.equal(path, PAPER_ENV); throw new Error('fixture'); } }), { code: 'CREDENTIAL_UNAVAILABLE' });

const activeLiveAccount = { id: 'live-account-id', status: 'ACTIVE', account_blocked: false, trading_blocked: false, trade_suspended_by_user: false };
assert.equal(assertLiveAccount(activeLiveAccount, { baseUrl: 'https://api.alpaca.markets' }).id, 'live-account-id');
for (const account of [null, {}, { ...activeLiveAccount, id: '' }, { ...activeLiveAccount, id: '94c3c77c-bf58-4dbb-ac57-5a9b9e41c40b' }, { ...activeLiveAccount, status: 'DISABLED' }, { ...activeLiveAccount, trading_blocked: true }, { ...activeLiveAccount, account_blocked: undefined }, { ...activeLiveAccount, paper: true }, { ...activeLiveAccount, mode: 'paper' }]) {
  assert.throws(() => assertLiveAccount(account, { baseUrl: 'https://api.alpaca.markets' }));
}
assert.throws(() => assertLiveAccount(activeLiveAccount, { baseUrl: 'https://paper-api.alpaca.markets' }), { code: 'LIVE_ENDPOINT_MISMATCH' });

let accountOptions;
const paths = await loadModeAccountPaths('live', { key: 'fixture-live-key', secret: 'fixture-live-secret' }, 'https://api.alpaca.markets', async (url, options) => {
  assert.equal(url, 'https://api.alpaca.markets/v2/account');
  accountOptions = options;
  return { ok: true, json: async () => activeLiveAccount };
});
assert.equal(accountOptions.method, 'GET');
assert.equal(accountOptions.redirect, 'error');
assert.ok(paths.directory.includes('/state/live-accounts/'));
await assert.rejects(loadModeAccountPaths('live', { key: 'fixture-live-key', secret: 'fixture-live-secret' }, 'https://api.alpaca.markets', async () => ({ ok: true, json: async () => ({ id: 'live-account-id' }) })), { code: 'LIVE_ACCOUNT_NOT_ACTIVE' });
await assert.rejects(loadModeAccountPaths('live', { key: 'fixture-live-key', secret: 'fixture-live-secret' }, 'https://api.alpaca.markets', async (_url, options) => {
  assert.equal(options.redirect, 'error');
  throw new Error('redirect blocked');
}), /redirect blocked/);

let brokerRequest;
let mockedBrokerCalls = 0;
const broker = createAlpacaBroker({ key: 'fixture-live-key', secret: 'fixture-live-secret', baseUrl: 'https://api.alpaca.markets', fetchImpl: async (url, options) => {
  mockedBrokerCalls++;
  brokerRequest = { url, options };
  return { ok: true, text: async () => JSON.stringify(activeLiveAccount) };
} });
await broker.inspectCurrentState();
assert.equal(brokerRequest.options.redirect, 'error');

console.log(JSON.stringify({ passed: true, checks: 'strict PAPER/LIVE credential path isolation, sanitized failures, LIVE account guards, exact account GET and redirect rejection', credentialFilesRead: 0, brokerTransport: 'mocked', brokerRequestCalls: mockedBrokerCalls, networkRequests: 0 }));
