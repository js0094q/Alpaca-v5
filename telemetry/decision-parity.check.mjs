import assert from 'node:assert/strict';
import { createEntry } from '../entry.mjs';
import { createPositions } from '../positions.mjs';
import { createSignal } from '../signal.mjs';

async function scenario(mode) {
  const events = [];
  const telemetry = mode === 'disabled' ? undefined : mode === 'faulting' ? () => { throw new Error('telemetry fault'); } : (event, fields) => events.push({ event, fields });
  const signals = [];
  const signal = createSignal({ telemetry, onBreakout: (event) => signals.push(event) });
  signal.setSession({ date: '2026-09-23', open: '2026-09-23T13:30:00.000Z', close: '2026-09-23T20:00:00.000Z' });
  signal.reset(Date.parse('2026-09-23T13:30:00.000Z'));
  const source = Date.parse('2026-09-23T13:32:00.000Z');
  for (const [ms, price] of [[source, 100], [source + 1000, 99.9], [source + 2000, 100.1]]) {
    signal.onTrade({ timestamp: new Date(ms).toISOString(), price, tradeId: `spy-${ms}`, exchange: 'Q', tape: 'C' }, ms);
  }

  const buyRequests = [];
  const entryFills = [];
  const entry = createEntry({
    telemetry,
    broker: { async submitOrder(request) { buyRequests.push({ symbol: request.symbol, qty: request.qty, side: request.side, limitPrice: request.limitPrice }); return { id: 'buy-order', status: 'new' }; } },
    getContracts: async () => [{ symbol: 'ATM', strike: 100, contractSize: 100 }, { symbol: 'OTM', strike: 101 }],
    getQuote: async (symbol) => ({ symbol, bid: 1, ask: 1.02, timestamp: '2026-09-23T13:32:02.000Z' }),
    onFill: (fill) => entryFills.push(fill),
    onState: () => {}, nowMono: () => 100,
  });
  await entry.onBreakout({ ...signals[0], spyPrice: 100.1 });
  const buy = entry.getState();
  entry.onOrderUpdate({ orderId: buy.orderId, clientOrderId: buy.clientOrderId, event: 'fill', executionId: 'entry-link-check', fillQty: 1, fillPrice: 1.02, timestamp: 100_000 });

  let now = 1_000;
  const sellRequests = [];
  const exits = [];
  const positions = createPositions({
    telemetry,
    now: () => now,
    nowMono: () => now,
    broker: {
      submitOrder(request) { sellRequests.push({ symbol: request.symbol, qty: request.qty, side: request.side, limitPrice: request.limitPrice }); return Promise.resolve({ id: 'sell-order', status: 'new' }); },
      replaceOrder: async () => ({ id: 'sell-order', status: 'new' }),
      cancelOrder: async () => {},
    },
    onExit: (exit) => exits.push({ tradeId: exit.tradeId, qty: exit.qty, price: exit.price, premiumPnlPerShare: exit.premiumPnlPerShare, contractSize: exit.contractSize, realizedPnlUsd: exit.realizedPnlUsd }),
  });
  positions.onFill({ tradeId: 'entry-exec:1', executionId: 'entry-exec', tradeSetId: 'buy-set', signalId: 'signal-1', symbol: 'SPY260923C00100000', entryPrice: 1, contractSize: 100, contractSizeSource: 'alpaca_contract_metadata', timestamp: now });
  const quote = (bid, at) => { now = at; positions.onQuote({ symbol: 'SPY260923C00100000', bid, ask: bid + 0.01, timestamp: new Date(at).toISOString() }); };
  quote(1, 11_000);
  quote(1.05, 11_100);
  quote(1.08, 11_200);
  quote(1.07, 11_300);
  await new Promise((resolve) => setImmediate(resolve));
  positions.onOrderUpdate({ orderId: 'sell-order', clientOrderId: 'v5-sell-test', event: 'fill', executionId: 'sell-exec', fillQty: 1, fillPrice: 1.07, timestamp: new Date(now).toISOString() });

  return {
    behavior: {
      signals: signals.map(({ direction, timestamp, spyPrice, sourceTradeId, priorHigh, priorLow }) => ({ direction, timestamp, spyPrice, sourceTradeId, priorHigh, priorLow })),
      buyRequests,
      entryLinks: entryFills.map((fill) => ({ contractSize: fill.contractSize, contractSizeSource: fill.contractSizeSource, hasSignalId: Boolean(fill.signalId), hasTradeSetId: Boolean(fill.tradeSetId), actionSource: fill.actionSource })),
      sellRequests,
      exits,
      finalPosition: positions.getTrades().map(({ remainingQty, anchorBid, profitFloor, sellLatched }) => ({ remainingQty, anchorBid, profitFloor, sellLatched })),
    },
    events,
  };
}

const disabled = await scenario('disabled');
const enabled = await scenario('enabled');
const faulting = await scenario('faulting');
assert.deepEqual(enabled.behavior, disabled.behavior);
assert.deepEqual(faulting.behavior, disabled.behavior);
for (const { event, fields } of enabled.events) assert(Object.keys(fields).length <= 32, `${event} exceeds bounded trace field limit`);
assert(enabled.events.some(({ event, fields }) => event === 'lot_decision' && fields.action === 'ANCHOR_SET' && fields.graceEndsAt === 11_000));
assert(enabled.events.some(({ event, fields }) => event === 'lot_decision' && fields.action === 'ARM_5C'));
assert(enabled.events.some(({ event, fields }) => event === 'lot_decision' && fields.action === 'REARM_8C'));
assert(enabled.events.some(({ event, fields }) => event === 'sell_latch' && fields.reason === 'profit_floor' && fields.tradeSetId === 'buy-set'));
assert.equal(enabled.events.find(({ event }) => event === 'entry_set')?.fields.maxBuyQty, 3);
assert.equal(enabled.events.find(({ event }) => event === 'position_exit')?.fields.tradeId, 'entry-exec:1');
assert.deepEqual(enabled.behavior.entryLinks, [{ contractSize: 100, contractSizeSource: 'alpaca_contract_metadata', hasSignalId: true, hasTradeSetId: true, actionSource: 'V5_AUTO' }]);
assert.deepEqual([enabled.behavior.exits[0].premiumPnlPerShare, enabled.behavior.exits[0].contractSize, enabled.behavior.exits[0].realizedPnlUsd], [0.07, 100, 7]);
console.log('telemetry/decision-parity.check.mjs: decisions match with telemetry disabled, enabled, and faulting');
