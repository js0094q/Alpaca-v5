import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAPER_ENV = join(homedir(), 'Documents', 'paper.env');
export const LIVE_ENV = join(homedir(), 'Documents', 'live.env');
const ROOT = dirname(fileURLToPath(import.meta.url));
const parseEnv = (text) => Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
  const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  return match ? [[match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]] : [];
}));

function parseLiveEnv(text) {
  const values = new Map();
  const names = new Set(['APCA_API_KEY', 'APCA_SECRET_KEY', 'APCIA_API_Key', 'APCIA_SECRET_KEY']);
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    if (!match || !names.has(match[1])) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/u, '$2');
    if (values.has(match[1]) && values.get(match[1]) !== value) throw credentialError('live', 'invalid');
    values.set(match[1], value);
  }
  const key = values.get('APCA_API_KEY'), keyAlias = values.get('APCIA_API_Key');
  const secret = values.get('APCA_SECRET_KEY'), secretAlias = values.get('APCIA_SECRET_KEY');
  if ((key !== undefined && keyAlias !== undefined && key !== keyAlias) || (secret !== undefined && secretAlias !== undefined && secret !== secretAlias)) throw credentialError('live', 'invalid');
  return { APCA_API_KEY: key ?? keyAlias, APCA_SECRET_KEY: secret ?? secretAlias };
}

const credentialError = (mode, reason) => Object.assign(new Error(`${mode.toUpperCase()} credentials are ${reason}.`), { code: 'CREDENTIAL_UNAVAILABLE' });

export async function loadModeCredentials(mode, { readFileImpl = readFile } = {}) {
  if (!['paper', 'live'].includes(mode)) throw new TypeError('mode must be paper or live');
  const path = mode === 'paper' ? PAPER_ENV : LIVE_ENV;
  let values;
  try {
    const source = await readFileImpl(path, 'utf8');
    values = mode === 'live' ? parseLiveEnv(source) : parseEnv(source);
  }
  catch { throw credentialError(mode, 'unavailable'); }
  const key = values.APCA_API_KEY, secret = values.APCA_SECRET_KEY;
  if ([key, secret].some((value) => typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\r\n]/u.test(value))) throw credentialError(mode, 'invalid');
  return { key, secret };
}

export function assertLiveAccount(account, { baseUrl } = {}) {
  if (baseUrl !== 'https://api.alpaca.markets') throw Object.assign(new Error('LIVE account endpoint is invalid.'), { code: 'LIVE_ENDPOINT_MISMATCH' });
  if (typeof account?.id !== 'string' || !account.id.trim() || account.id === '94c3c77c-bf58-4dbb-ac57-5a9b9e41c40b' || account.paper === true || account.mode === 'paper') throw Object.assign(new Error('Authenticated account is not a valid LIVE account.'), { code: 'LIVE_ACCOUNT_ID_INVALID' });
  if (account.status !== 'ACTIVE') throw Object.assign(new Error('LIVE account is not active.'), { code: 'LIVE_ACCOUNT_NOT_ACTIVE' });
  if (account.account_blocked !== false || account.trading_blocked !== false || account.trade_suspended_by_user !== false) throw Object.assign(new Error('LIVE account trading status is incomplete or blocked.'), { code: 'LIVE_ACCOUNT_BLOCKED' });
  return account;
}

export async function loadCloseoutCredentials(path = PAPER_ENV) {
  const values = parseEnv(await readFile(path, 'utf8'));
  if (!values.APCA_API_KEY || !values.APCA_SECRET_KEY) throw new Error('required Alpaca credentials are missing');
  return { key: values.APCA_API_KEY, secret: values.APCA_SECRET_KEY };
}

export function paperAccountPaths(account) {
  if (typeof account?.id !== 'string' || !account.id.trim()) throw new Error('PAPER_ACCOUNT_ID_MISSING');
  const accountHash = createHash('sha256').update(account.id).digest('hex');
  const directory = join(ROOT, 'state', 'paper-accounts', accountHash);
  return { accountHash, directory, continuity: join(directory, 'v5-active-state.json'),
    ledger: join(directory, 'paper-ledger.log'),
    marketOpen: join(directory, 'market-open') };
}

export function modeAccountPaths(mode, account) {
  if (!['paper', 'live'].includes(mode)) throw new TypeError('mode must be paper or live');
  if (mode === 'paper') return paperAccountPaths(account);
  if (typeof account?.id !== 'string' || !account.id.trim()) throw new Error('LIVE_ACCOUNT_ID_MISSING');
  const accountHash = createHash('sha256').update(account.id).digest('hex');
  const directory = join(ROOT, 'state', 'live-accounts', accountHash);
  return { accountHash, directory, continuity: join(directory, 'v5-active-state.json'),
    ledger: join(directory, 'live-ledger.log'),
    marketOpen: join(directory, 'market-open') };
}

export async function loadPaperAccountPaths(credentials, fetchImpl = fetch) {
  return loadModeAccountPaths('paper', credentials, 'https://paper-api.alpaca.markets', fetchImpl);
}

export async function loadModeAccountPaths(mode, credentials, baseUrl, fetchImpl = fetch) {
  if (!['paper', 'live'].includes(mode)) throw new TypeError('mode must be paper or live');
  const expectedUrl = mode === 'paper' ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
  if (baseUrl !== undefined && baseUrl !== expectedUrl) throw new Error('Mode and Alpaca API URL do not match');
  const response = await fetchImpl(`${expectedUrl}/v2/account`, {
    method: 'GET',
    redirect: 'error',
    headers: { 'APCA-API-KEY-ID': credentials.key, 'APCA-API-SECRET-KEY': credentials.secret },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`${mode.toUpperCase()}_ACCOUNT_LOOKUP_FAILED`);
  const account = await response.json();
  if (mode === 'live') assertLiveAccount(account, { baseUrl: expectedUrl });
  return modeAccountPaths(mode, account);
}
