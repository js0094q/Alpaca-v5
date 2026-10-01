import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAPER_ENV = join(homedir(), 'Documents', 'paper.env');
const ROOT = dirname(fileURLToPath(import.meta.url));
const parseEnv = (text) => Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
  const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  return match ? [[match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]] : [];
}));

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
    ledger: join(directory, 'paper-ledger.log'), closeoutLedger: join(directory, 'closeout-ledger.log'),
    marketOpen: join(directory, 'market-open') };
}

export function modeAccountPaths(mode, account) {
  if (!['paper', 'live'].includes(mode)) throw new TypeError('mode must be paper or live');
  if (mode === 'paper') return paperAccountPaths(account);
  if (typeof account?.id !== 'string' || !account.id.trim()) throw new Error('LIVE_ACCOUNT_ID_MISSING');
  const accountHash = createHash('sha256').update(account.id).digest('hex');
  const directory = join(ROOT, 'state', 'live-accounts', accountHash);
  return { accountHash, directory, continuity: join(directory, 'v5-active-state.json'),
    ledger: join(directory, 'live-ledger.log'), closeoutLedger: join(directory, 'live-ledger.log'),
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
    headers: { 'APCA-API-KEY-ID': credentials.key, 'APCA-API-SECRET-KEY': credentials.secret },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`${mode.toUpperCase()}_ACCOUNT_LOOKUP_FAILED`);
  return modeAccountPaths(mode, await response.json());
}
