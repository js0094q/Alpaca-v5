import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAPER_ACCOUNT_ID } from './alpaca-bot-bridge/config.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const TRADE_AUTHORITY_LOCK = join(ROOT, 'state', 'v5-trade-authority.lock');
export const MANUAL_OWNERSHIP_MARKER = join(ROOT, 'state', 'v5-trade-authority.manual.json');

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
      throw Object.assign(new Error('PAPER trade authority is already held or requires operator lock recovery.'), { code: 'PAPER_TRADE_AUTHORITY_LOCKED', owner: existing && { pid: existing.pid, role: existing.role, acquiredAt: existing.acquiredAt } });
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

async function readMarker(markerPath = MANUAL_OWNERSHIP_MARKER) {
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    if (marker?.schema !== 1 || marker.accountId !== PAPER_ACCOUNT_ID || !Array.isArray(marker.orders)) throw new Error('invalid marker');
    return marker;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw Object.assign(new Error('BRIDGE_MANUAL ownership marker is unreadable.'), { code: 'MANUAL_MARKER_UNKNOWN' });
  }
}

export async function recordManualOrder({ symbol, clientOrderId, side, qty, filledQty = null, orderId = null, status = 'unknown', terminal = false }, { markerPath = MANUAL_OWNERSHIP_MARKER } = {}) {
  if (typeof symbol !== 'string' || !/^SPY\d{6}[CP]\d{8}$/u.test(symbol) || typeof clientOrderId !== 'string' || !clientOrderId.startsWith('bridge-manual-') || !['buy', 'sell'].includes(side)) throw new TypeError('invalid BRIDGE_MANUAL ownership record');
  const marker = await readMarker(markerPath) ?? { schema: 1, accountId: PAPER_ACCOUNT_ID, createdAt: new Date().toISOString(), orders: [] };
  const order = { symbol, clientOrderId, side, qty: qty == null ? null : String(qty), filledQty: filledQty == null ? null : String(filledQty), orderId, status, terminal: Boolean(terminal), updatedAt: new Date().toISOString() };
  const index = marker.orders.findIndex((item) => item.clientOrderId === clientOrderId);
  if (index >= 0) marker.orders[index] = order; else marker.orders.push(order);
  marker.updatedAt = new Date().toISOString();
  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 });
  const tempPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(tempPath, markerPath);
  return { status: 'active', orders: marker.orders.length };
}

const unbox = (value) => value && typeof value === 'object' && Object.hasOwn(value, 'ok') ? value.ok ? value.data : null : value;

export async function readManualOwnershipMarker({ markerPath = MANUAL_OWNERSHIP_MARKER } = {}) { return readMarker(markerPath); }

export async function reconcileManualOwnership(snapshot, { markerPath = MANUAL_OWNERSHIP_MARKER, readOrder } = {}) {
  const marker = await readMarker(markerPath);
  if (!marker) return { status: 'none' };
  const account = unbox(snapshot?.account);
  const positions = unbox(snapshot?.positions);
  const orders = unbox(snapshot?.openOrders ?? snapshot?.orders);
  if (account?.id !== PAPER_ACCOUNT_ID || !Array.isArray(positions) || !Array.isArray(orders)) return { status: 'unknown', orders: marker.orders.length };
  if (typeof readOrder === 'function') {
    for (const entry of marker.orders.filter((item) => !item.terminal)) {
      let result;
      try { result = await readOrder(entry); } catch { continue; }
      const order = result && typeof result === 'object' && Object.hasOwn(result, 'ok') ? result.ok ? result.data : null : result?.data ?? result;
      if (order && (order.id === entry.orderId || order.client_order_id === entry.clientOrderId)) {
        entry.orderId = order.id ?? entry.orderId; entry.status = order.status ?? entry.status;
        entry.filledQty = order.filled_qty ?? entry.filledQty; entry.terminal = ['filled', 'canceled', 'cancelled', 'rejected', 'expired', 'replaced'].includes(String(entry.status).toLowerCase()); entry.updatedAt = new Date().toISOString();
      }
    }
    marker.updatedAt = new Date().toISOString();
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  const activeStatus = (status) => ['new', 'accepted', 'pending_new', 'partially_filled', 'pending_replace', 'pending_cancel'].includes(String(status ?? '').toLowerCase());
  const unresolved = marker.orders.some((item) => !item.terminal && !activeStatus(item.status));
  if (positions.length || orders.length || marker.orders.some((item) => !item.terminal)) return { status: unresolved ? 'unknown' : 'active', orders: marker.orders.length, symbols: [...new Set(marker.orders.map((item) => item.symbol))] };
  await unlink(markerPath);
  return { status: 'cleared' };
}

export async function assertManualMarkerClear(snapshot, options = {}) {
  const account = unbox(snapshot?.account), positions = unbox(snapshot?.positions), orders = unbox(snapshot?.openOrders ?? snapshot?.orders);
  if (account?.id !== PAPER_ACCOUNT_ID) throw Object.assign(new Error('Authenticated account does not match the bound V5 PAPER identity.'), { code: 'PAPER_ACCOUNT_ID_MISMATCH' });
  if (!Array.isArray(positions) || !Array.isArray(orders)) throw Object.assign(new Error('PAPER positions or open orders are unavailable.'), { code: 'BROKER_STATE_UNKNOWN' });
  const state = await reconcileManualOwnership(snapshot, options);
  if (state.status !== 'none' && state.status !== 'cleared') throw Object.assign(new Error('BRIDGE_MANUAL order or unresolved outcome remains; V5 cannot assume ownership.'), { code: 'MANUAL_OWNERSHIP_UNRESOLVED', state });
  return state;
}
