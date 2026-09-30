import { createHash } from 'node:crypto';
import { mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const FILE_PREFIX = 'post-exit-';
const MAX_ROW_BYTES = 64 * 1024;
const MAX_ACTIVE_WINDOWS = 256;
const identifier = /^[a-zA-Z0-9_-]{1,160}$/;
const fail = (code) => Object.assign(new Error(code), { code });

export async function createEvidenceWriter({ directory, runId, retentionMs = 30 * 86_400_000,
  maxTotalBytes = 256 * 1024 * 1024, now = Date.now } = {}) {
  if (typeof directory !== 'string' || !directory || !identifier.test(runId ?? '') ||
      !Number.isFinite(retentionMs) || retentionMs < 1 ||
      !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < MAX_ROW_BYTES || typeof now !== 'function') {
    throw fail('INVALID_EVIDENCE_CONFIGURATION');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const active = new Map();
  let closed = false;
  let failed = false;
  let storedBytes = 0;
  let partition = null;

  const expire = async () => {
    const cutoff = now() - retentionMs;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(FILE_PREFIX) || !entry.name.endsWith('.jsonl')) continue;
      const path = join(directory, entry.name);
      const info = await stat(path);
      if (info.mtimeMs < cutoff && ![...active.values()].some((item) => item.path === path)) {
        await unlink(path);
        storedBytes -= info.size;
      }
    }
  };

  await expire();
  storedBytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith(FILE_PREFIX) && entry.name.endsWith('.jsonl')) {
      storedBytes += (await stat(join(directory, entry.name))).size;
    }
  }

  const validate = (row) => {
    if (!row || row.schema !== 1 || row.runId !== runId || !identifier.test(row.windowId ?? '') ||
        !['POST_EXIT_START', 'POST_EXIT_QUOTE', 'POST_EXIT_END', 'POST_EXIT_GAP'].includes(row.event) ||
        !Number.isFinite(row.wallTimeMs) || !row.fields || typeof row.fields !== 'object' || Array.isArray(row.fields)) {
      throw fail('INVALID_EVIDENCE_ROW');
    }
    const required = ['mode', 'accountHash', 'tradeId', 'entrySetId', 'entryExecutionId',
      'exitExecutionId', 'symbol', 'entryTimestampMs', 'exitTimestampMs'];
    if (required.some((key) => !Object.hasOwn(row.fields, key)) ||
        !['paper', 'live'].includes(row.fields.mode) ||
        typeof row.fields.accountHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.fields.accountHash) ||
        ![null, undefined].includes(row.fields.entryTimestampMs) && !Number.isFinite(row.fields.entryTimestampMs) ||
        ![null, undefined].includes(row.fields.exitTimestampMs) && !Number.isFinite(row.fields.exitTimestampMs)) {
      throw fail('INVALID_EVIDENCE_IDENTITY');
    }
    for (const [key, value] of Object.entries(row.fields)) {
      if (!/^[a-zA-Z0-9_]{1,64}$/.test(key) ||
          !(value === null || typeof value === 'string' || typeof value === 'boolean' ||
            typeof value === 'number' && Number.isFinite(value))) throw fail('INVALID_EVIDENCE_FIELD');
    }
    const line = `${JSON.stringify(row)}\n`;
    if (Buffer.byteLength(line) > MAX_ROW_BYTES) throw fail('EVIDENCE_ROW_TOO_LARGE');
    return line;
  };

  return {
    async write(row) {
      if (failed) throw fail('EVIDENCE_WRITER_FAILED');
      if (closed) throw fail('EVIDENCE_WRITER_CLOSED');
      const line = validate(row);
      const id = row.windowId;
      let item = active.get(id);
      let persisted = line;
      if (row.event === 'POST_EXIT_START') {
        if (item) throw fail('DUPLICATE_EVIDENCE_WINDOW');
        if (active.size >= MAX_ACTIVE_WINDOWS) throw fail('EVIDENCE_ACTIVE_WINDOW_CAPACITY');
        const nextPartition = `${row.fields.mode}:${row.fields.accountHash}`;
        if (partition && partition !== nextPartition) throw fail('EVIDENCE_PARTITION_CHANGED');
        await expire();
        const copy = { ...row, fields: { ...row.fields, retentionMs, maxTotalBytes } };
        persisted = `${JSON.stringify(copy)}\n`;
        if (Buffer.byteLength(persisted) > MAX_ROW_BYTES) throw fail('EVIDENCE_ROW_TOO_LARGE');
        if (storedBytes + Buffer.byteLength(persisted) > maxTotalBytes) throw fail('EVIDENCE_CAPACITY');
        const windowHash = createHash('sha256').update(`${runId}:${id}`).digest('hex');
        const path = join(directory, `${FILE_PREFIX}${windowHash}.jsonl`);
        let handle;
        try { handle = await open(path, 'ax', 0o600); }
        catch (error) { if (error?.code === 'EEXIST') throw fail('DUPLICATE_EVIDENCE_WINDOW'); throw error; }
        item = { handle, path, bytes: 0, identity: ['mode', 'accountHash', 'tradeId', 'entrySetId', 'entryExecutionId', 'exitExecutionId', 'symbol', 'entryTimestampMs', 'exitTimestampMs'].map((key) => row.fields[key]) };
        active.set(id, item);
      } else if (!item) {
        throw fail('EVIDENCE_WINDOW_NOT_OPEN');
      } else {
        const identity = ['mode', 'accountHash', 'tradeId', 'entrySetId', 'entryExecutionId', 'exitExecutionId', 'symbol', 'entryTimestampMs', 'exitTimestampMs'].map((key) => row.fields[key]);
        if (identity.some((value, index) => value !== item.identity[index])) throw fail('EVIDENCE_IDENTITY_CHANGED');
      }
      if (storedBytes + Buffer.byteLength(persisted) > maxTotalBytes) throw fail('EVIDENCE_CAPACITY');
      try {
        await item.handle.writeFile(persisted);
        const size = Buffer.byteLength(persisted);
        item.bytes += size;
        storedBytes += size;
        if (row.event === 'POST_EXIT_START' && !partition) partition = `${row.fields.mode}:${row.fields.accountHash}`;
      } catch (error) {
        failed = true;
        await Promise.all([...active.values()].map((entry) => entry.handle.close().catch(() => {})));
        active.clear();
        throw Object.assign(fail('EVIDENCE_WRITE_FAILED'), { cause: error });
      }
      if (row.event === 'POST_EXIT_END') {
        await item.handle.close();
        active.delete(id);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const item of active.values()) await item.handle.close();
      active.clear();
    },
  };
}
