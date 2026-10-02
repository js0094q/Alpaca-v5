import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createAlpacaBroker as createAlpacaBrokerImpl } from './alpaca.mjs';
const createAlpacaBroker = (options) => createAlpacaBrokerImpl({ baseUrl: 'https://paper-api.alpaca.markets', ...options });
const { createEntry } = await import(process.env.ENTRY_MODULE ? pathToFileURL(process.env.ENTRY_MODULE) : './entry.mjs');
const cases = JSON.parse(await readFile(new URL('./entry-403.fixture.json', import.meta.url), 'utf8'));
const flush = () => new Promise((resolve) => setImmediate(resolve));

for (const fixture of cases) {
  const set = fixture.events.find((row) => row.event === 'entry_set');
  const error = fixture.events.find((row) => row.event === 'buy_api_error');
  const stuck = fixture.events.find((row) => row.event === 'entry_state');
  assert.equal(stuck.fields.orderStatus, 'UNKNOWN_OUTCOME');
  assert.equal(error.fields.httpStatus, 403);
  const f = set.fields;
  const breakout = { direction: f.direction, spyPrice: f.spyPrice, timestamp: f.signalTimestamp };
  const inputs = { getContracts: async () => [{ symbol: f.symbol, strike: Number(f.symbol.slice(-8)) / 1000 }], getQuote: () => ({ bid: f.bid, ask: f.ask, timestamp: f.quoteTimestamp }), nowMono: () => set.monoMs };
  let requests = 0;
  const broker = createAlpacaBroker({ key: 'test', secret: 'test', fetchImpl: async (_url, options) => {
    requests++;
    const order = JSON.parse(options.body);
    assert.equal(order.qty, f.quantity);
    assert.equal(order.limit_price, f.limitPrice);
    return new Response('', { status: error.fields.httpStatus });
  } });
  const entry = createEntry({ ...inputs, broker });
  await entry.onBreakout(breakout);
  assert.equal(entry.getState().state, 'DONE', fixture.source);
  assert.equal(entry.getState().orderStatus, 'rejected');
  assert.equal(entry.getState().active, false);
  entry.ready();
  await entry.onBreakout(breakout);
  assert.equal(requests, 2, 'next independent signal can submit');

  for (const httpStatus of [undefined, 500]) {
    const unknown = createEntry({ ...inputs, broker: { async submitOrder() { throw Object.assign(new Error('ambiguous'), { httpStatus }); } } });
    await unknown.onBreakout(breakout);
    unknown.ready();
    assert.equal(unknown.getState().orderStatus, 'UNKNOWN_OUTCOME');
    assert.equal(unknown.getState().active, true);
  }

  for (const event of ['new', 'partial_fill', 'fill', 'canceled', 'rejected']) {
    let release, submitted;
    const pending = new Promise((resolve) => { submitted = resolve; });
    let mono = set.monoMs;
    const fills = [], cancels = [];
    let race;
    race = createEntry({ ...inputs, nowMono: () => mono, onFill: (fill) => fills.push(fill),
      // Same synchronous reset used by runtime for terminal zero-ownership events.
      onState: (s) => { if (['canceled', 'rejected'].includes(s.status)) race.ready(); },
      broker: { submitOrder() { submitted(); return new Promise((_resolve, reject) => { release = () => reject(Object.assign(new Error('403'), { httpStatus: 403 })); }); }, async cancelOrder(id) { cancels.push(id); } } });
    const run = race.onBreakout(breakout);
    await pending;
    const cid = race.getState().clientOrderId;
    const qty = event === 'fill' ? 3 : event === 'partial_fill' ? 1 : 0;
    race.onOrderUpdate({ clientOrderId: cid, orderId: 'accepted-before-response', event, executionId: qty ? 'execution' : undefined, fillQty: qty, fillPrice: f.ask, timestamp: f.signalTimestamp });
    release();
    await run;
    assert.equal(fills.length, qty);
    if (['canceled', 'rejected'].includes(event)) {
      assert.equal(race.getState().state, 'IDLE');
      assert.equal(race.getState().orderStatus, null);
    } else if (event === 'fill') assert.equal(race.getState().state, 'FILLED');
    else {
      assert.equal(race.getState().state, 'WORKING');
      assert.equal(race.getState().orderId, 'accepted-before-response');
      assert.equal(race.nextDeadline(), set.monoMs + (qty ? 5000 : 2000));
      mono = race.nextDeadline();
      race.tick();
      await flush();
      assert.deepEqual(cancels, ['accepted-before-response']);
    }
  }
}
const f = cases[0].events.find((row) => row.event === 'entry_set').fields;
const breakout = { direction: f.direction, spyPrice: f.spyPrice, timestamp: f.signalTimestamp };
const inputs = { getContracts: async () => [{ symbol: f.symbol, strike: Number(f.symbol.slice(-8)) / 1000 }], getQuote: () => ({ bid: f.bid, ask: f.ask }), nowMono: () => 0 };
for (const [httpStatus, code, message, expected] of [
  [422, 42210000, 'option opening order not accepted', 'rejected'],
  [400, 40010000, 'invalid request', 'rejected'],
  [422, 42210000, 'client_order_id already exists', 'UNKNOWN_OUTCOME'],
  [422, 42210000, 'client_order_id has already been used', 'UNKNOWN_OUTCOME'],
  [409, 40910000, 'conflict', 'UNKNOWN_OUTCOME'],
  [408, 40810000, 'timeout', 'UNKNOWN_OUTCOME'],
  [429, 42910000, 'rate limit', 'UNKNOWN_OUTCOME'],
  [503, 50310000, 'unavailable', 'UNKNOWN_OUTCOME'],
]) {
  const broker = createAlpacaBroker({ key: 'test', secret: 'test', fetchImpl: async () => new Response(JSON.stringify({ code, message }), { status: httpStatus }) });
  await assert.rejects(broker.submitOrder({ symbol: f.symbol, qty: 3, side: 'buy', limitPrice: f.limitPrice, clientOrderId: 'test' }), (error) => {
    assert.equal(error.httpStatus, httpStatus);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    return true;
  });
  const entry = createEntry({ ...inputs, broker });
  await entry.onBreakout(breakout);
  assert.equal(entry.getState().orderStatus, expected, `${httpStatus} ${message}`);
  assert.equal(entry.getState().state, expected === 'rejected' ? 'DONE' : 'SUBMITTING');
  assert.equal(entry.getState().orderId, null);
}
console.log('BUY rejection behavior checks passed (4xx, ambiguous errors, broker event races).');
