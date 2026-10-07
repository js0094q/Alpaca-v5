import assert from 'node:assert/strict';
import { createEntry } from './entry.mjs';

export async function demo() {
  const select = async ({ direction, spyPrice, contracts, quotes }) => {
    const quoteCalls = [];
    let submitted = null;
    const entry = createEntry({
      broker: { async submitOrder(order) { submitted = order; return { id: 'selection-order', status: 'new' }; } },
      getContracts: async () => contracts,
      getQuote: async (symbol) => { quoteCalls.push(symbol); return quotes[symbol]; },
      onState: () => {},
      nowMono: () => 0,
    });
    await entry.onBreakout({ direction, spyPrice, timestamp: 1 });
    return { submitted, quoteCalls, state: entry.getState() };
  };

  const normal = await select({
    direction: 'CALL', spyPrice: 100.1,
    contracts: [{ symbol: 'LOW', strike: 99 }, { symbol: 'NEAREST', strike: 100 }, { symbol: 'HIGH', strike: 101 }],
    quotes: { NEAREST: { bid: 1, ask: 1.02 } },
  });
  assert.equal(normal.submitted.symbol, 'NEAREST');

  const callTie = await select({
    direction: 'CALL', spyPrice: 100.5,
    contracts: [{ symbol: 'LOW', strike: 100 }, { symbol: 'HIGH', strike: 101 }],
    quotes: { HIGH: { bid: 1, ask: 1.02 } },
  });
  assert.equal(callTie.submitted.symbol, 'HIGH');

  const putTie = await select({
    direction: 'PUT', spyPrice: 100.5,
    contracts: [{ symbol: 'LOW', strike: 100 }, { symbol: 'HIGH', strike: 101 }],
    quotes: { LOW: { bid: 1, ask: 1.02 } },
  });
  assert.equal(putTie.submitted.symbol, 'LOW');

  const tiedFallback = await select({
    direction: 'CALL', spyPrice: 100.5,
    contracts: [{ symbol: 'LOW', strike: 100 }, { symbol: 'HIGH', strike: 101 }, { symbol: 'OTM', strike: 102 }, { symbol: 'UNSEARCHED', strike: 103 }],
    quotes: { HIGH: { bid: 1, ask: 1.06 }, OTM: { bid: 0.5, ask: 0.55 } },
  });
  assert.equal(tiedFallback.submitted.symbol, 'OTM');
  assert.deepEqual(tiedFallback.quoteCalls, ['HIGH', 'OTM']);

  const failedFallback = await select({
    direction: 'PUT', spyPrice: 100.5,
    contracts: [{ symbol: 'LOW', strike: 100 }, { symbol: 'HIGH', strike: 101 }, { symbol: 'OTM', strike: 99 }, { symbol: 'UNSEARCHED', strike: 98 }],
    quotes: { LOW: { bid: 1, ask: 1.06 }, OTM: { bid: 0.5, ask: 0.56 } },
  });
  assert.equal(failedFallback.submitted, null);
  assert.deepEqual(failedFallback.quoteCalls, ['LOW', 'OTM']);

  const invalidBid = await select({ direction: 'CALL', spyPrice: 100,
    contracts: [{ symbol: 'ATM', strike: 100 }, { symbol: 'OTM', strike: 101 }],
    quotes: { ATM: { bid: 0, ask: 0.01 }, OTM: { bid: 0.5, ask: 0.55 } },
  });
  assert.equal(invalidBid.submitted.symbol, 'OTM', 'a zero bid fails quote quality');

  const exactSpread = await select({ direction: 'CALL', spyPrice: 100,
    contracts: [{ symbol: 'ATM', strike: 100 }, { symbol: 'OTM', strike: 101 }],
    quotes: { ATM: { bid: 1, ask: 1.05 }, OTM: { bid: 0.5, ask: 0.55 } },
  });
  assert.equal(exactSpread.submitted.symbol, 'ATM', 'a five-cent ATM spread is eligible');

  const tooWide = await select({ direction: 'CALL', spyPrice: 100,
    contracts: [{ symbol: 'ATM', strike: 100 }, { symbol: 'OTM', strike: 101 }],
    quotes: { ATM: { bid: 1, ask: 1.054 }, OTM: { bid: 0.5, ask: 0.554 } },
  });
  assert.equal(tooWide.submitted, null, 'a spread above five cents cannot round down into eligibility');

  const capitalCalls = [], capitalQuotes = [];
  const unaffordable = createEntry({ quantity: 1, strategyCapital: 460.45,
    broker: { async submitOrder(order) { capitalCalls.push(order); return { id: 'capital-order', status: 'new' }; } },
    getContracts: async () => [{ symbol: 'ATM', strike: 100 }, { symbol: 'OTM', strike: 101 }],
    getQuote: async (symbol) => { capitalQuotes.push(symbol); return symbol === 'ATM' ? { bid: 4.61, ask: 4.65 } : { bid: 1, ask: 1.02 }; }, nowMono: () => 0,
  });
  await unaffordable.onBreakout({ direction: 'CALL', spyPrice: 100, timestamp: 1 });
  assert.equal(unaffordable.getState().pausedReason, 'ENTRY_CAPITAL_LIMIT');
  assert.equal(capitalCalls.length, 0, 'an unaffordable quality-valid ATM does not fall back to OTM');
  assert.deepEqual(capitalQuotes, ['ATM']);

  let t = 1000;
  const calls = [];
  const fills = [];
  const quotes = { ATM: { symbol: 'ATM', bid: 1, ask: 1.06, timestamp: 1 }, OTM1: { symbol: 'OTM1', bid: 0.5, ask: 0.54, timestamp: 1 }, OTM2: { symbol: 'OTM2', bid: 0.4, ask: 0.44, timestamp: 1 } };
  const quoteCalls = [];
  const broker = {
    async submitOrder(x) { calls.push(['submit', x]); await new Promise((r) => setTimeout(r, 5)); return { id: `o${calls.filter((x) => x[0] === 'submit').length}`, status: 'new' }; },
    async replaceOrder(id, x) { calls.push(['replace', id, x]); return { id: 'o-replaced', status: 'new' }; },
    async cancelOrder(id) { calls.push(['cancel-request', id]); },
  };
  let releaseSubmit;
  let submitted;
  const submittedSignal = new Promise((resolve) => { submitted = resolve; });
  const submitGate = new Promise((resolve) => { releaseSubmit = resolve; });
  broker.submitOrder = async (x) => { calls.push(['submit', x]); submitted(); await submitGate; return { id: `o${calls.filter((x) => x[0] === 'submit').length}`, status: 'new' }; };
  const entry = createEntry({ broker, getContracts: async () => [{ symbol: 'ATM', strike: 100 }, { symbol: 'OTM1', strike: 101 }, { symbol: 'OTM2', strike: 102 }], getQuote: async (s) => { quoteCalls.push(s); return quotes[s]; }, onFill: (x) => fills.push(x), onState: () => {}, nowMono: () => t });
  const first = entry.onBreakout({ direction: 'CALL', timestamp: 1, spyPrice: 100 });
  assert.equal(entry.getState().active, true);
  await submittedSignal;
  t = 2500;
  releaseSubmit();
  await first;
  await entry.onBreakout({ direction: 'CALL', timestamp: 1, spyPrice: 100 });
  assert.equal(calls[0][1].symbol, 'OTM1');
  assert.equal(quoteCalls.includes('OTM2'), false);
  assert.equal(calls[0][1].limitPrice, 0.54);
  assert.equal(entry.nextDeadline(), 3000);
  quotes.OTM1 = { ...quotes.OTM1, ask: 0.9 };
  entry.tick();
  assert.equal(calls.filter((x) => x[0] === 'replace').length, 0);
  const cid = entry.getState().clientOrderId;
  entry.onOrderUpdate({ executionId: 'e1', clientOrderId: cid, orderId: 'o1', event: 'partial_fill', fillQty: 1, fillPrice: 0.54, timestamp: '2026-09-21T13:00:00.000Z' });
  entry.onOrderUpdate({ executionId: 'e1', clientOrderId: cid, orderId: 'o1', event: 'partial_fill', fillQty: 1, fillPrice: 0.54, timestamp: '2026-09-21T13:00:00.000Z' });
  assert.equal(fills.length, 1);
  assert.equal(entry.nextDeadline(), 7500);
  t = 8000;
  entry.tick();
  await new Promise((r) => setImmediate(r));
  entry.onOrderUpdate({ executionId: 'e2', orderId: 'o1', event: 'canceled', fillQty: 0, timestamp: '2026-09-21T13:00:01.000Z' });
  entry.ready();
  quotes.OTM1 = { ...quotes.OTM1, ask: 0.54 };
  await entry.onBreakout({ direction: 'CALL', timestamp: 4, spyPrice: 100 });
  assert.equal(calls.filter((x) => x[0] === 'submit').length, 2);
  return { calls, fills };
}

if (import.meta.url === `file://${process.argv[1]}`) await demo();
