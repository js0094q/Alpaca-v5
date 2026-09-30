import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PAPER_ACCOUNT_ID = '94c3c77c-bf58-4dbb-ac57-5a9b9e41c40b';
const credentialValues = new Set();

function envValue(source, name) {
  const value = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*?)\\s*$`, 'mi').exec(source)?.[1];
  return value && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) ? value.slice(1, -1) || null : value || null;
}

export async function resolvePaper({ readFileImpl = readFile } = {}) {
  let key;
  let secret;
  try {
    const source = await readFileImpl(join(homedir(), 'Documents', 'paper.env'), 'utf8');
    key = envValue(source, 'APCA_API_KEY');
    secret = envValue(source, 'APCA_SECRET_KEY');
  } catch {
    throw Object.assign(new Error('PAPER credentials are unavailable.'), { code: 'CREDENTIAL_UNAVAILABLE' });
  }
  if (typeof key !== 'string' || typeof secret !== 'string' || !key.trim() || !secret.trim() || key.length > 1024 || secret.length > 1024 || /[\r\n]/u.test(key + secret)) {
    throw Object.assign(new Error('PAPER credentials are invalid.'), { code: 'CREDENTIAL_UNAVAILABLE' });
  }
  credentialValues.add(key);
  credentialValues.add(secret);
  return Object.freeze({ mode: 'paper', baseUrl: 'https://paper-api.alpaca.markets', dataUrl: 'https://data.alpaca.markets', apiKey: key, apiSecret: secret });
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /(?:api.?key|secret|token|authorization)/iu.test(key) && !['page_token', 'next_page_token'].includes(key) ? '[REDACTED]' : redact(item)]));
  if (typeof value === 'string') { let result = value; for (const credential of credentialValues) if (credential) result = result.split(credential).join('[REDACTED]'); return result; }
  return value;
}
