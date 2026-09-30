import { parentPort, workerData } from 'node:worker_threads';
import { mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// This worker alone serializes and writes telemetry; it has no trading or API imports.
export async function createWriter({ directory, runId, maxBytes = 64 * 1024 * 1024, maxSegments = 256 }) {
  if (!Number.isInteger(maxBytes) || maxBytes < 2048 || !Number.isInteger(maxSegments) || maxSegments < 2 || maxSegments > 256) throw new Error('INVALID_RETENTION');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let handle, bytes = 0, segment = 0;
  const pattern = /^v5-trace-\d{13}-[a-f0-9-]+-\d{6}\.jsonl$/;
  const rotate = async () => {
    await handle?.close(); handle = null;
    const files = (await readdir(directory)).filter((name) => pattern.test(name)).sort();
    const removed = [];
    while (files.length >= maxSegments) {
      const index = files.findIndex((name) => !name.includes(`-${runId}-`));
      if (index < 0) {
        const error = new Error('current-run-retention-limit');
        error.code = 'RETENTION_LIMIT';
        throw error;
      }
      const [name] = files.splice(index, 1);
      await unlink(join(directory, name)); removed.push(name);
    }
    handle = await open(join(directory, `v5-trace-${Date.now()}-${runId}-${String(segment++).padStart(6, '0')}.jsonl`), 'ax', 0o600);
    const header = JSON.stringify({ schema: 1, runId, event: 'TRACE_SEGMENT_START', wallTimeMs: Date.now(), fields: { maxBytes, maxSegments, removedCount: removed.length, removed: removed.slice(0, 3), continuity: 'retention prunes prior runs only; current run is preserved' } }) + '\n';
    await handle.writeFile(header); bytes = Buffer.byteLength(header);
  };
  await rotate();
  return {
    async write(row) {
      let line = JSON.stringify(row) + '\n';
      if (Buffer.byteLength(line) > maxBytes / 2) line = JSON.stringify({ schema: 1, runId, event: 'TRACE_RECORD_DROPPED', wallTimeMs: Date.now(), fields: { reason: 'record_exceeds_segment_budget', sequence: row.sequence ?? null } }) + '\n';
      if (bytes + Buffer.byteLength(line) > maxBytes) await rotate();
      await handle.writeFile(line); bytes += Buffer.byteLength(line);
    },
    async writeBatch(rows) {
      const lines = [];
      for (const row of rows) {
        let line = JSON.stringify(row) + '\n';
        if (Buffer.byteLength(line) > maxBytes / 2) line = JSON.stringify({ schema: 1, runId, event: 'TRACE_RECORD_DROPPED', wallTimeMs: Date.now(), fields: { reason: 'record_exceeds_segment_budget', sequence: row.sequence ?? null } }) + '\n';
        if (bytes + Buffer.byteLength(line) > maxBytes) {
          if (lines.length) await handle.writeFile(lines.join(''));
          lines.length = 0;
          await rotate();
        }
        lines.push(line);
        bytes += Buffer.byteLength(line);
      }
      if (lines.length) {
        const payload = lines.join('');
        await handle.writeFile(payload);
      }
    },
    async close() { await handle?.close(); },
  };
}

if (parentPort) {
  let writer, failed = false;
  const fail = async (error) => {
    if (failed) return;
    failed = true;
    parentPort.postMessage({ type: 'failure', code: ['ENOSPC', 'RETENTION_LIMIT'].includes(error?.code) ? error.code : 'WRITER_FAILED' });
    await writer?.close().catch(() => {}); parentPort.close();
  };
  try {
    writer = await createWriter(workerData);
    parentPort.on('message', async (message) => {
      if (failed) return;
      try {
        if (message.type === 'batch') {
          await writer.writeBatch(message.rows);
          await writer.write({ schema: 1, runId: workerData.runId, event: 'TRACE_BATCH_STATS', wallTimeMs: Date.now(), fields: message.stats });
          parentPort.postMessage({ type: 'ack' });
        } else if (message.type === 'stop') {
          await writer.write({ schema: 1, runId: workerData.runId, event: 'TRACE_STOP', wallTimeMs: Date.now(), fields: message.stats });
          await writer.close(); parentPort.postMessage({ type: 'stopped' }); parentPort.close();
        }
      } catch (error) { await fail(error); }
    });
    parentPort.postMessage({ type: 'ready' });
  } catch (error) { await fail(error); }
}
