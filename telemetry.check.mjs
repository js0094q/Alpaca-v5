import assert from 'node:assert/strict';
import { createPositions } from './positions.mjs';
import { createRuntime } from './runtime.mjs';
import { createSignal } from './signal.mjs';

export async function demo() {
  const events = [];
  const broker = { async submitOrder() { return { id: 's1', status: 'accepted' }; }, async replaceOrder(id) { return { id, status: 'accepted' }; }, async cancelOrder() {} };
  const p = createPositions({ broker, getDayStartCapital: () => 400, onTelemetry: (e) => events.push(e) });
  p.onFill({ executionId: 'buy', tradeId: 't1', symbol: 'SPY', entryPrice: 2, timestamp: 1 });
  p.onQuote({ symbol: 'SPY', bid: 2.5, ask: 2.51, timestamp: 10_001 });
  p.onQuote({ symbol: 'SPY', bid: 1.01, ask: 1.02, timestamp: 10_002 }); // one cent above the frozen 25% loss threshold
  assert.equal(p.getTrades()[0].sellLatched, false);
  p.onQuote({ symbol: 'SPY', bid: 1, ask: 1.01, timestamp: 10_003 }); // equality latches
  p.onQuote({ symbol: 'SPY', bid: 0, ask: 1.06, timestamp: 10_004 }); // rejected quote: no telemetry
  assert.deepEqual(events.filter((e) => e.type === 'quote').map((e) => e.bid), [2.5, 1.01, 1]);
  const decisions = events.filter((e) => e.type === 'decision');
  assert.deepEqual(decisions.map((e) => e.kind), ['stop_latch']);
  assert.equal(decisions[0].tradeId, 't1');
  assert.equal(decisions[0].bid, 1);
  assert.equal(decisions[0].quoteTimestamp, 10_003);
  assert.ok(!Number.isNaN(Date.parse(decisions[0].at)));

  const silent = createPositions({ broker, onTelemetry: () => { throw new Error('sink down'); } });
  silent.onFill({ executionId: 'buy', tradeId: 't2', symbol: 'QQQ', entryPrice: 1, timestamp: 1 });
  silent.onQuote({ symbol: 'QQQ', bid: 1.5, ask: 1.51, timestamp: 10_001 });
  assert.equal(silent.getTrades()[0].mfeCents, 50); // telemetry failure never touches trading

  const open = Date.parse('2026-10-07T13:30:00Z'), rangeEnd = open + 15 * 60_000;
  const iso = (t) => new Date(t).toISOString();
  const session = { date: '2026-10-07', open: iso(open), close: iso(open + 6.5 * 60 * 60_000) };
  const calendar = { sessionFor: (t) => ({ ...session, status: t >= open && t < Date.parse(session.close) ? 'open' : 'closed' }) };
  let wall = open - 60_000;
  const statuses = [], orders = [];
  const runtime = createRuntime({ calendar, now: () => wall, nowMono: () => wall,
    broker: { inspectCurrentState: async () => ({ positions: [], orders: [] }), submitOrder: async (o) => { orders.push(o); return { id: 'unexpected' }; } },
    getContracts: async () => [], getQuote: async () => null,
    continuity: { load: () => ({ status: 'missing', trades: [] }), save: () => {} },
    telemetry: (event) => statuses.push(event),
  });
  await runtime.startup();
  assert.equal(statuses.at(-1).type, 'runtime_status');
  assert.equal(statuses.at(-1).signal.rangeStatus, 'PENDING');
  runtime.onMarketDataStatus({ status: 'subscription_confirmed', timestamp: wall });
  const print = (price, id, conditions = [' ']) => runtime.onRawTrade({ T: 't', S: 'SPY', p: price, t: iso(wall), c: conditions, i: id, x: 'Q', z: 'A' });
  wall = open; print(100, 1); runtime.tick();
  assert.equal(statuses.at(-1).signal.rangeStatus, 'COLLECTING');
  assert.ok(statuses.at(-1).blockers.includes('COLLECTING_RANGE'));
  const count = statuses.length;
  wall += 500; print(102, 2); runtime.tick();
  assert.equal(statuses.length, count, 'heartbeat is bounded to one record per five seconds');
  wall = rangeEnd; print(102.1, 3); runtime.tick();
  const ready = statuses.at(-1);
  assert.equal(ready.entryEligible, true);
  assert.deepEqual(ready.blockers, []);
  assert.deepEqual([ready.signal.high, ready.signal.low, ready.signal.margin, ready.signal.callTrigger, ready.signal.putTrigger], [102, 100, 0.2, 102.2, 99.8]);
  assert.equal(ready.signal.rangeStatus, 'VALID');
  assert.equal(ready.signal.lastPrint.price, 102.1);
  assert.equal(ready.signal.lastBreakout, null, 'sub-margin print is not reported as a trigger');
  wall += 5_000; runtime.tick();
  assert.equal(statuses.at(-1).signal.lastPrint.ageMs, 5_000, 'no new data shows an aging print');
  print(103, 4, ['I']);
  wall += 5_000; runtime.tick();
  assert.equal(statuses.at(-1).sip.lastRejectedReason, 'non-price-forming-condition');
  assert.equal(statuses.at(-1).sip.rejected, 1);
  print(102.2, 5);
  await new Promise((resolve) => setImmediate(resolve));
  wall += 5_000; runtime.tick();
  assert.equal(statuses.at(-1).signal.lastBreakout.direction, 'CALL');
  assert.equal(statuses.at(-1).entry.reason, 'NO_CONTRACTS', 'selection refusal remains observable');
  assert.equal(orders.length, 0, 'observing a qualifying print does not invent a contract or an order');
  runtime.onMarketDataStatus({ status: 'disconnected', timestamp: wall });
  wall += 5_000; runtime.tick();
  assert.equal(statuses.at(-1).signal.rangeStatus, 'VALID', 'post-range disconnect does not rewrite observed range coverage');
  assert.ok(statuses.at(-1).blockers.includes('SIP_DISCONNECTED'));
  wall = Date.parse('2026-10-07T15:30:00Z'); runtime.tick();
  assert.equal(statuses.at(-1).entryEligible, false);
  assert.ok(statuses.at(-1).blockers.includes('ENTRY_WINDOW_CLOSED'));
  runtime.stop();

  for (const [kind, expected] of [['late', 'LATE_START'], ['gap', 'OPENING_RANGE_GAP'], ['subscription', 'SIP_NOT_READY_AT_OPEN']]) {
    const s = createSignal({ onBreakout: () => assert.fail('invalid range must never emit a breakout') });
    s.setSession(session); s.reset(kind === 'late' ? open + 1 : open - 1);
    s.onMarketDataStatus({ status: 'subscription_confirmed', timestamp: kind === 'subscription' ? open + 1 : open - 1 });
    s.onTrade({ timestamp: open + 2, price: 100 }, open + 2);
    if (kind === 'gap') {
      s.onMarketDataStatus({ status: 'disconnected', timestamp: open + 1_000 });
      s.onMarketDataStatus({ status: 'reconnected', timestamp: open + 2_000 });
    }
    s.onTrade({ timestamp: rangeEnd, price: 110 }, rangeEnd);
    assert.equal(s.getStatus(rangeEnd).rangeStatus, 'INVALID');
    assert.equal(s.getStatus(rangeEnd).rangeBlocker, expected);
    assert.equal(s.getStatus(rangeEnd).entryEligible, false);
  }
  for (const sink of [() => { throw Error('offline'); }, () => Promise.reject(Error('offline'))]) {
    const r = createRuntime({ calendar, now: () => open, nowMono: () => open, telemetry: sink,
      broker: { inspectCurrentState: async () => ({ positions: [], orders: [] }) },
      getContracts: async () => [], getQuote: async () => null,
      continuity: { load: () => ({ status: 'missing', trades: [] }), save: () => {} },
    });
    await r.startup(); r.tick();
    assert.equal(r.getState().state, 'FLAT', 'telemetry failure cannot change runtime state');
    r.stop();
  }
  await new Promise((resolve) => setImmediate(resolve));
  console.log('telemetry check passed');
}
if (import.meta.url === `file://${process.argv[1]}`) await demo();
