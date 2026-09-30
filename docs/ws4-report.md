# WS4 report

Implemented the approved independent runtime and REST broker boundary.

- `runtime.mjs` instantiates and wires the real signal, entry, and positions factories; coordinates startup inspection, interrupted BUY cancellation, exposure state, breakout forwarding, order updates, 500 ms ticks, session cutoff checks, and the five-second monotonic cooldown.
- `alpaca.mjs` provides native `fetch` PAPER REST order operations and normalized decoded trade updates. Replacement omits quantity so Alpaca preserves the original total order quantity.
- `runtime.check.mjs` contains a real-factory mocked-broker replay: interrupted BUY cancellation gating, signal warmup, BUY3 fill, quote-driven SELL, full exits, cooldown, and second-cycle readiness. The parent runs it after integration.

Blocked by explicit unresolved decisions: exact SIP eligibility, and restart restoration of each contract's original basis and armed floor. Startup reports `BLOCKED_OWNERSHIP` for current SPY option exposure. Raw binary OPRA/trade-update transport remains unimplemented within WS4.
