import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContinuity } from './continuity.mjs';
import { createRuntime } from './runtime.mjs';

const sessionOpen = Date.parse('2026-09-23T13:30:00Z');
const calendar = { sessionFor: () => ({ date: '2026-09-23', status: 'open', open: new Date(sessionOpen).toISOString(), close: '2026-09-23T20:00:00Z' }) };
const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)); };

async function checkFailure(kind) {
  let wall = sessionOpen;
  let attempts = 0;
  let submissions = 0;
  const tempDir = mkdtempSync(join(tmpdir(), 'v5-selection-failure-'));
  const unhandled = [];
  const listener = (error) => unhandled.push(error);
  process.on('unhandledRejection', listener);
  const runtime = createRuntime({
    broker: {
      inspectCurrentState: async () => ({ positions: [], orders: [] }),
      submitOrder: async () => { submissions += 1; return { id: `order-${submissions}`, status: 'new' }; },
    },
    calendar,
    now: () => wall,
    nowMono: () => wall - sessionOpen,
    continuity: createContinuity({ path: join(tempDir, 'state.json') }),
    getContracts: async () => {
      attempts += 1;
      if (kind === 'contracts' && attempts === 1) throw new Error('contracts unavailable');
      return [{ symbol: 'ATM', strike: 660 }, { symbol: 'OTM', strike: 661 }, { symbol: 'OTM2', strike: 662 }];
    },
    getQuote: async (symbol) => {
      if (kind === 'atm-quote' && attempts === 1) throw new Error('ATM quote unavailable');
      if (kind === 'fallback-quote' && attempts === 1 && symbol === 'ATM') return { bid: 1, ask: 1.04 };
      if (kind === 'fallback-quote' && attempts === 1 && symbol === 'OTM') throw new Error('fallback quote unavailable');
      return { bid: 1, ask: 1.02, timestamp: new Date(wall).toISOString() };
    },
  });

  try {
    await runtime.startup();
    // The signal detector requires a two-minute opening delay and a prior range.
    for (let i = 0; i < 30; i += 1) {
      wall = sessionOpen + 120_000 + i * 100;
      runtime.onTrade({ timestamp: new Date(wall).toISOString(), price: 659 });
    }
    const breakout = async (price) => {
      wall += 1_000;
      runtime.onTrade({ timestamp: new Date(wall).toISOString(), price });
      await flush();
    };

    await breakout(660);
    assert.equal(runtime.getState().entry.pausedReason, 'SELECTION_FAILED', `${kind}: selection failure is recorded`);
    assert.equal(runtime.getState().entry.state, 'IDLE', `${kind}: entry returns to IDLE`);
    assert.equal(runtime.getState().state, 'FLAT', `${kind}: runtime returns to FLAT`);
    assert.equal(submissions, 0, `${kind}: no order is submitted on selection failure`);
    assert.deepEqual(unhandled, [], `${kind}: rejection is handled`);

    await breakout(661);
    assert.equal(submissions, 1, `${kind}: a later valid selection can submit`);
    assert.equal(runtime.getState().entry.state, 'WORKING', `${kind}: later selection reaches normal order handling`);
    assert.equal(runtime.getState().entry.pausedReason, null, `${kind}: prior selection failure is cleared`);
    assert.deepEqual(unhandled, [], `${kind}: no unhandled rejection occurs during recovery`);
  } finally {
    runtime.stop();
    process.off('unhandledRejection', listener);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

for (const kind of ['contracts', 'atm-quote', 'fallback-quote']) await checkFailure(kind);
console.log('selection-failure checks passed (contracts, ATM quote, fallback quote)');
