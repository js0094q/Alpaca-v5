#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { tools as brokerTools } from './broker.mjs';
import { assertBotStopped, tools as runtimeTools } from './runtime.mjs';
import { acquireTradeAuthority } from '../trade-authority.mjs';
import { tools as reconcileTools } from './reconcile.mjs';
import { createServer } from './server.mjs';

const scopedRuntimeTools = runtimeTools.filter(({ name }) => !/^(shell|file|filesystem)_/u.test(name));
const withManualAuthority = async (operation) => {
  const release = await acquireTradeAuthority('bridge-manual');
  try { await assertBotStopped(); return await operation(); }
  finally { await release(); }
};
const server = await createServer([brokerTools, scopedRuntimeTools, reconcileTools], { withManualAuthority });
const transport = new StdioServerTransport();
await server.connect(transport);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void server.close().finally(() => process.exit(0)); });
}
