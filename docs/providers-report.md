# WS3 real Alpaca providers

`providers.mjs` exposes the neutral provider boundary consumed by V5:

- `createAlpacaProviders({ key, secret, fetchImpl?, WebSocketImpl? })` returns `getContracts(direction, timestamp)`, `getQuote(symbol)`, `calendar`, and `connect({ onRawTrade, onQuote, onTradeUpdate, onDisconnect, onStatus, optionSymbols })`.
- `calendar.loadCalendar({ start, end })` fetches Alpaca's actual trading calendar and caches session rows. Synchronous `calendar.sessionFor(now)` returns the cached exchange date, DST-correct open/close ISO timestamps, status, and next session metadata. It does not create strategy cutoffs.
- `getContracts` requests every active same-day SPY call or put contract, follows `next_page_token`, and returns `{ symbol, strike }` rows without selecting an ATM contract.
- `getQuote` requests the latest OPRA quote and returns `{ symbol, bid, ask, timestamp }`.
- `connect` opens three explicit streams: SIP SPY trades (`v2/sip`), OPRA option quotes (`v1beta1/opra`), and PAPER `trade_updates` (`wss://paper-api.alpaca.markets/stream`). SIP emits normalized raw trade, correction, and cancel events to `onRawTrade` unconditionally; OPRA forwards every quote event in arrival order; trade updates pass through the existing `normalizeTradeUpdate`.
- `subscribeOptions(symbols)` adds explicit option symbols only. `stop()` unsubscribes and closes all sockets. Disconnects are reported through `onDisconnect`; there is no retry loop or automatic signal callback.

The OPRA socket uses the documented `application/msgpack` handshake and `@msgpack/msgpack` encoder/decoder for both control frames and data. PAPER trade updates remain JSON on the wire, including binary UTF-8 frames. Each stream subscribes only after its authenticated response; authentication errors are surfaced through `onStatus` and do not produce readiness or subscriptions. `ws` supplies the custom handshake header that Node's native WebSocket does not expose. The focused offline check is `npm run check:providers`; it uses representative documented JSON/MsgPack frames, exercises pagination, and uses mocked HTTP/WebSocket transports, never an authenticated connection or broker mutation.

Documentation examples are examples, not captured Alpaca data.

Sources: [Alpaca market-data WebSocket](https://docs.alpaca.markets/us/docs/streaming-market-data), [real-time stock SIP stream](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data), [trade-update WebSocket](https://docs.alpaca.markets/us/docs/websocket-streaming), and [option contracts API](https://docs.alpaca.markets/us/reference/get-options-contracts-1).
