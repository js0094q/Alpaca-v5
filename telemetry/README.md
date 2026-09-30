# V5 active observational telemetry

`trace.mjs` adds a bounded primitive event queue to the V5 process. `writer.mjs` runs in a separate worker thread and alone serializes JSON and writes/rotates files. Neither module imports the broker, providers, credentials, trading runtime, or a network client. Hooks observe existing values and requests; they do not request additional market/broker data, change decisions, retry orders, or repair trading behavior.

## Main-thread boundary

`createTrace({directory, enabled})` returns synchronous `emit`, `status`, and `stop`; directory accepts a filesystem string or file URL. `observe(emit,event,fields)` contains callback exceptions. An emitter call performs only bounded primitive copies, timestamps and queue insertion: no reads, disk writes, await, or JSON serialization. Nested values are discarded, strings capped at 256 characters, event names at 80, keys at 64 and fields at 32. Failed/full/stopping emitters return false and count drops; trading never waits for space.

The queue holds at most 8,192 records plus one in-flight batch of at most 512 records. Up to 512 queue slots are reserved for bounded lifecycle and order evidence; high-rate quote observations cannot consume them. A 50ms timer dispatches batches and the worker writes each batch as aggregated JSONL. A single worker acknowledgment is required before another batch; there is no unbounded postMessage backlog. Bursts or sustained input above writer capacity can still lose evidence. Structured cloning occurs on dispatch, not on each emit; its CPU cost is not zero.

Worker failures mark telemetry failed, abandon its bounded queue, and do not restart the worker or bot. Failure/drop counters remain readable through `status()`. `written` means worker-acknowledged emitted records. Unacknowledged records at failure are conservatively counted as dropped even if some reached disk. A failed sink may be unable to persist its last counters. Sequence gaps, batch counters, explicit record-drop events and retention notices must be considered when judging completeness.

`stop()` does not await. It requests a final drain and temporarily holds the event loop for at most three seconds, then terminates only the worker if necessary. The normal timer and worker are unreferenced so they do not keep trading alive by themselves. A forced process kill may lose queued/in-flight events and leave a partial final line. No telemetry path signals, gates, or restarts trading.

## Output and reconstruction

The paper integration uses `telemetry-trace/` beside `paper.mjs`. Records have schema version 1, run ID, per-attempt sequence, wall-clock milliseconds, monotonic milliseconds, event name, and primitive `fields`. Original market/broker timestamps are separate fields. Worker metadata records use wall time and may omit the trading-event sequence. These are observed active events, not independently sampled market prices.

The hooks record:

- Signal range and direction, signal key/ID, contract selection, spread, midpoint, frozen entry cap and entry-set BUY client ID.
- BUY submit/reprice/cancel request and response, broker order IDs, fills and links from entry set to execution and per-contract trade ID.
- Per-lot accepted bid/quote timestamp, actual evaluated bid, age, grace state, prior/new phase, HOLD, LOSS_SUPPRESSED_BY_GRACE, LOSS_LATCH, TRAIL_ARM and PROFIT_FLOOR_LATCH decisions.
- SELL latch reason/time, logical SELL ID, submission/replacement and response/error, broker order updates, partial/final fills and remaining quantity.
- Existing SIP/OPRA/trade-update connection/status/disconnection observations and provider/API errors. A reconnect callback alone is not proof of restored connectivity.
- Existing drain broker snapshots versus local ownership and ledger dispatch/persisted-write counters. This is observation of non-atomic existing data, not an additional broker read, accounting repair, or fabricated reconciliation.

Retain at most **256 × 64 MiB JSONL (16 GiB)**. Rotation may delete oldest complete segments from prior runs, but never segments from the current run; if the current run fills the cap, the writer fails closed for telemetry with `RETENTION_LIMIT` and preserves existing files. New segment headers disclose retention deletion counts and up to three filenames. Each run starts a fresh segment; previous bytes are never edited. Single records exceeding half a segment are replaced by explicit drop records. One active writer per output directory is assumed. No database, dashboard, framework or dependency is introduced.

The 16 GiB cap is a planning budget for the next full session: extrapolating September 28's observed pace through 16:00 ET gives roughly 12–13 GiB. It does not guarantee full-day retention at arbitrary volume. Queue saturation and writer failures still drop telemetry without affecting trading.

## Verification artifacts

Run `node telemetry/check.mjs` from the staged checkout beside the preserved `baseline/` directory. After deployment, pass the preserved baseline explicitly:

```sh
node telemetry/check.mjs --baseline /Users/josephstew/.codex/task-evidence/v5-active-telemetry-2026-09-24/baseline
```

This uses mocked broker calls and temporary disk output only, never live credentials/APIs or bot processes. It compares original baseline actions/state against disabled, enabled, throwing-observer, saturated and failed-sink runs. Actual signal callbacks drive all representative entries: the 30-second prior range is joined by signal key to selection and entry-set IDs, then to nine lots across grace/loss, trail arm/peak/strict retreat, and run-up/retreat scenarios. Each set has a one-contract partial BUY, repricing of the remainder, then a separate two-contract BUY execution. Each of its three one-contract lots exits through a whole-contract SELL fill; no fractional option contracts are modeled. It also checks URL initialization, primitive bounds, worker exit/stall isolation, output failure, finite stop and bounded rotation.

The check preserves `evidence/representative.jsonl`, `evidence/reconstruction.json` and `evidence/check-report.json` after deleting temporary test output. These are explicitly **mocked replay evidence, not live trades**. The report includes measured emitter and three-lot quote-evaluation p50/p95/p99 and means for baseline, disabled and enabled paths. The synchronous microbenchmark intentionally gives enough queue room to accept all samples; it does not establish live latency, sustained throughput, or zero overhead. Original unchanged bot checks and deployment/live evidence are separate parent responsibilities.
