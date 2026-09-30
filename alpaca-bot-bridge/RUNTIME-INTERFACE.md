# Runtime inspection interface

Public runtime tools read only the bound V5 PAPER account and do not accept an account-mode selector. Internal helpers may receive the literal `paper` to select account-scoped state. No LIVE state or credential route is exposed.

`localSnapshot('paper')` reads the authenticated broker account identity and selects that account's hashed V5 state directory. It returns continuity, ledger, telemetry, session artifacts, broker snapshot, owned positions, post-exit evidence and entry state. Missing files and truncated pages remain explicit. Historical root telemetry has unverified account ownership unless exact identifiers establish a link.

`readLocalHistory({ mode: 'paper', date, ... })` is bounded by date, paging and optional exact trade/run/entry-set identifiers. `readPostExitEvidence(paths, 'paper', limit, offset, file)` returns account-scoped sampled option quote windows and coverage. Only actual usable, ordered post-exit option bids count as attributable samples; a complete window requires its boundary sample. Missing coverage remains Unknown.

The three manual broker-order tools require `BRIDGE_MANUAL`, V5 stopped, and the shared trade-authority lock. Runtime inspection and reconciliation do not start, stop, gate or change the V5 strategy.
