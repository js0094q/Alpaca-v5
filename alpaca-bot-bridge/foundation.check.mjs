import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { toolResult } from './server.mjs';
import { tools as brokerTools } from './broker.mjs';
import { tools as runtimeTools } from './runtime.mjs';
import { tools as reconcileTools } from './reconcile.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const expected = [...brokerTools, ...runtimeTools.filter(({ name }) => !/^(shell|file|filesystem)_/u.test(name)), ...reconcileTools].map(({ name }) => name).sort();
const nestedPartialFailure = {
  mode: 'paper',
  brokerResponse: { ok: true, status: 207, partialResults: [{ ok: false, status: 422, code: 'ORDER_REJECTED' }] },
  after: { ok: true, status: 200 },
};
const failedResult = toolResult('broker_cancel_all', nestedPartialFailure);
assert.equal(failedResult.isError, true);
assert.deepEqual(failedResult.structuredContent, nestedPartialFailure);
assert.deepEqual(JSON.parse(failedResult.content[0].text), nestedPartialFailure);
assert.equal(toolResult('broker_cancel_all', { brokerResponse: { ok: true, partialResults: [{ ok: true }] } }).isError, undefined);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['index.mjs'],
  cwd: directory,
  stderr: 'inherit',
});
const client = new Client({ name: 'alpaca-bot-bridge-foundation-check', version: '0.1.0' });

async function checkMixedProtocolCalls() {
  const child = spawn(process.execPath, ['index.mjs'], { cwd: directory, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const wait = pending.get(message.id);
    if (!wait) return;
    pending.delete(message.id);
    clearTimeout(wait.timer);
    wait.resolve(message);
  });
  child.once('exit', (code) => {
    for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(new Error(`stdio server exited (${code})`)); }
    pending.clear();
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 5000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  try {
    const discovery = await request('server/discover');
    assert.equal(discovery.error?.code, -32601, 'unsupported discovery must allow a legacy initialize fallback');
    const initialized = await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'alpaca-bot-bridge-foundation-check', version: '0.1.0' },
    });
    assert.equal(initialized.result?.protocolVersion, '2025-11-25', `legacy initialization failed: ${JSON.stringify(initialized)}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const catalog = await request('tools/list');
    assert.ok(catalog.result?.tools?.length, 'legacy catalog listing must work');
    const call = await request('tools/call', { name: 'repo_status', arguments: {} });
    assert.ok(call.result?.structuredContent, `legacy repository read failed: ${call.error?.message ?? 'missing result'}`);
    const rejected = await request('tools/call', { name: 'broker_account', arguments: { mode: 'live' } });
    assert.ok(rejected.result?.isError || rejected.error, 'broker call with unknown fields must be rejected before execution');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    lines.close();
  }
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), expected);
  assert.ok(tools.length > 0, 'the bridge must expose at least one registered tool');
  for (const tool of tools) {
    const mutating = ['broker_submit_order', 'broker_cancel_order', 'broker_replace_order'].includes(tool.name);
    assert.equal(tool.annotations?.readOnlyHint, !mutating, `${tool.name} operation hint`);
    assert.equal(tool.annotations?.destructiveHint, mutating);
    assert.ok(!/^(?:broker|bot)_/.test(tool.name) || !/(?:^|_)(?:place|replace|cancel|close|start|stop|restart|test|write|delete|publish)(?:_|$)/u.test(tool.name) || ['broker_cancel_order', 'broker_replace_order'].includes(tool.name));
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject undeclared input fields`);
    if (/^(broker|bot)_/u.test(tool.name)) assert.equal(Object.hasOwn(tool.inputSchema.properties, 'mode'), false, `${tool.name} must not expose an environment selector`);
  }
  await checkMixedProtocolCalls();
  process.stdout.write(`foundation check passed: ${tools.length} tools advertised; no broker operation called\n`);
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
