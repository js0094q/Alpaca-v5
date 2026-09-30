import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { redact } from './config.mjs';

const safeMessages = Object.freeze({
  INVALID_INPUT: 'The request is invalid.',
  INVALID_MODE: 'The requested environment mode is invalid.',
  CAPABILITY_UNAVAILABLE: 'The requested capability is unavailable.',
  CONFLICT: 'The request conflicts with current state.',
  RATE_LIMITED: 'The upstream service rate limit was reached.',
  UPSTREAM_ERROR: 'The upstream service request failed.',
  NETWORK_ERROR: 'The broker read request failed.',
  RESPONSE_READ_ERROR: 'The broker response could not be read.',
  CREDENTIAL_UNAVAILABLE: 'Credentials for the selected mode are unavailable.',
  ACCOUNT_ID_UNAVAILABLE: 'The broker account identifier is unavailable.',
  ACCOUNT_ID_MISMATCH: 'Authenticated account does not match the bound V5 PAPER identity.',
  PAPER_ROUTE_REJECTED: 'Only the bound PAPER broker and market-data endpoints are allowed.',
  ORDER_OWNERSHIP_MISMATCH: 'The order is not owned by BRIDGE_MANUAL.',
  MANUAL_OWNERSHIP_UNRESOLVED: 'BRIDGE_MANUAL ownership requires exact broker resolution before V5 can start.',
  MANUAL_START_NOT_FLAT: 'A manual BUY requires an empty PAPER account and no open orders.',
  MANUAL_SELL_OWNERSHIP_MISMATCH: 'A manual SELL requires a confirmed BRIDGE_MANUAL position and enough quantity.',
  BROKER_STATE_UNKNOWN: 'Current PAPER account state is incomplete; order control failed closed.',
  BOT_STATUS_UNKNOWN: 'Manual order controls are unavailable until V5 is confirmed stopped.',
  INTERNAL_ERROR: 'The capability failed safely.',
});

function result(value) {
  value = redact(value);
  const text = JSON.stringify(value);
  if (text === undefined) throw Object.assign(new Error(), { code: 'INTERNAL_ERROR' });
  return { content: [{ type: 'text', text }], structuredContent: value };
}

async function schemaFor(tool) {
  let inputSchema;
  let advertisedSchema;
  if (tool.inputSchema?.['~standard']?.jsonSchema?.input) {
    inputSchema = tool.inputSchema;
    advertisedSchema = await inputSchema['~standard'].jsonSchema.input();
  } else if (tool.inputSchema?.type === 'object') {
    const schema = tool.inputSchema;
    if (!schema.properties || schema.additionalProperties !== false) {
      throw new TypeError(`Tool ${tool.name} must declare a strict object JSON Schema`);
    }
    inputSchema = fromJsonSchema({ ...schema, required: Array.isArray(schema.required) ? schema.required : [] });
    advertisedSchema = await inputSchema['~standard'].jsonSchema.input();
  } else {
    throw new TypeError(`Tool ${tool.name} must declare a JSON Schema or Standard Schema`);
  }
  if (advertisedSchema.type !== 'object' || advertisedSchema.additionalProperties !== false) {
    throw new TypeError(`Tool ${tool.name} must reject undeclared input fields`);
  }
  if (/^(broker|bot)_/u.test(tool.name) && Object.hasOwn(advertisedSchema.properties ?? {}, 'mode')) throw new TypeError(`Tool ${tool.name} must be bound to PAPER without a public mode selector`);
  return { inputSchema, advertisedSchema };
}

function failure(error) {
  const rawCode = typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR';
  const code = /^[A-Z][A-Z0-9_]{0,63}$/u.test(rawCode) ? rawCode : 'INTERNAL_ERROR';
  return {
    ...result({ error: code, message: safeMessages[code] ?? 'The capability failed safely.' }),
    isError: true,
  };
}

function brokerFailed(value) {
  const pending = [value];
  for (let index = 0; index < pending.length; index += 1) {
    const item = pending[index];
    if (!item || typeof item !== 'object') continue;
    if (item.ok === false || (Array.isArray(item.partialResults) && item.partialResults.some((part) => part?.ok !== true))) return true;
    for (const key of ['account', 'orders', 'openOrders', 'fills', 'positions', 'before', 'brokerResponse', 'response', 'after']) {
      if (item[key] && typeof item[key] === 'object') pending.push(item[key]);
    }
  }
  return false;
}

export function toolResult(name, value) {
  const response = result(value);
  if (name.startsWith('broker_') && brokerFailed(value)) response.isError = true;
  return response;
}

export async function createServer(groups, executionContext = {}) {
  if (!Array.isArray(groups) || groups.length !== 3) throw new TypeError('Expected broker, runtime, and reconcile tool groups');
  const tools = groups.flat();
  const names = new Set();
  const schemas = new Map();
  for (const tool of tools) {
    if (
      !tool || typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/u.test(tool.name) ||
      /^(shell|file|filesystem)_/u.test(tool.name) ||
      (/^(?:broker|bot)_/u.test(tool.name) && /(?:^|_)(?:place|replace|cancel|close|start|stop|restart|test|write|delete|publish)(?:_|$)/u.test(tool.name) && !['broker_cancel_order', 'broker_replace_order'].includes(tool.name)) ||
      names.has(tool.name) || typeof tool.description !== 'string' || !tool.description.trim() ||
      !tool.inputSchema || typeof tool.handler !== 'function'
    ) throw new TypeError('Invalid or duplicate tool definition');
    schemas.set(tool.name, await schemaFor(tool));
    names.add(tool.name);
  }

  const server = new McpServer(
    { name: 'Alpaca Bot Bridge', version: '0.2.0' },
    { instructions: 'This bridge is bound exclusively to the V5 PAPER account; no environment selector or LIVE capability is available. Broker reads are available alongside explicitly attributed BRIDGE_MANUAL PAPER order controls. V5_AUTO and BRIDGE_MANUAL ownership remain distinct. Broker orders, fills and positions establish execution; local ledger and telemetry explain decisions. SIP/OPRA explain market context. Historical transactions are not executable bids; retained quotes are sampled evidence. Missing evidence remains unknown.' },
  );

  for (const { name, description, handler } of tools) {
    server.registerTool(name, { description, inputSchema: schemas.get(name).inputSchema, annotations: { readOnlyHint: !['broker_submit_order', 'broker_cancel_order', 'broker_replace_order'].includes(name), destructiveHint: ['broker_submit_order', 'broker_cancel_order', 'broker_replace_order'].includes(name), idempotentHint: !['broker_submit_order', 'broker_cancel_order', 'broker_replace_order'].includes(name) } }, async (args) => {
      try {
        const value = await handler(args, executionContext);
        return toolResult(name, value);
      } catch (error) {
        return failure(error);
      }
    });
  }
  return server;
}
