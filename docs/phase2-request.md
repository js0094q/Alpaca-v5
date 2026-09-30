Use this as the next Astra prompt. It keeps the four streams parallel while preventing unresolved policy choices from being silently implemented.

# Target

Advance **The Final Trading Bot V5** from the current partial-integration checkpoint by running **four bounded parallel Luna workstreams**.

Authoritative project: Notebook `6d36bb46-bc94-426e-aab0-fe71535ac969`.

Current integration checkpoint is authoritative: local module checks and simulated end-to-end replay pass, but V5 is **not deployed, not live-PAPER validated, and not complete**.

Astra is the **orchestrator/integrator only**. Luna performs substantive implementation or investigation.

Do not reopen completed WS2/WS3 behavior.

# Objective

Resolve or narrow the remaining integration blockers and complete only the runtime/provider work that does **not** require an unapproved strategy or continuity decision.

Run the four workstreams concurrently in isolated scopes.

Do not deploy the bot, submit broker orders, or leave a runtime running.

---

# Global constraints

Astra and Luna must not:

- invent policy where Notebook says a user decision is still required;
- choose an SIP eligibility rule without evidence and approval;
- invent a restart basis/floor reconstruction method;
- choose an ATM tie direction;
- reintroduce V4 reconciliation, Valkey, database authority, historical order reconstruction, account-freshness gates, or durable-flat machinery;
- alter BUY, SELL, profit, loss, breakout, timing, quantity, partial-fill, or cooldown rules;
- search for unrelated bugs or edge cases;
- redesign architecture;
- create new indicators, strategy gates, telemetry systems, or broad testing programs;
- deploy or send actual PAPER orders;
- continue working after these four deliverables are complete.

If an unresolved decision is encountered, preserve it explicitly and return the evidence needed for the user to decide.

---

# WORKSTREAM 1 — SIP ELIGIBILITY + SOURCE ORDERING

## Target
Determine the exact minimal SIP trade-eligibility and ordering rule needed before `signal.mjs`.

## Objective
Turn the current vague phrase “eligible SPY trade” into an evidence-backed, understandable proposed rule without silently implementing an arbitrary filter.

## Scope
Luna may:

- inspect the current V5 signal interface;
- inspect official Alpaca SIP/trade-stream documentation;
- inspect historical V4 filtering behavior **read-only** only if useful for understanding what previously worked;
- identify which Alpaca trade fields/conditions materially determine whether a print should participate in the 30-second range;
- determine how timestamp/order sequencing should be handled when messages arrive with source timestamps that differ from receipt order;
- identify the smallest rule sufficient for the approved V5 breakout behavior.

## Do not
- copy the retired filter automatically;
- implement accept-all merely because no rule exists;
- add volume, bar aggregation, indicators, or momentum scoring;
- modify breakout semantics.

## Deliverable
Return:

1. observed Alpaca SIP fields/semantics;
2. the historical rule, if inspected;
3. the smallest recommended eligibility/order predicate in ELI5 language;
4. any materially different alternative that genuinely requires user choice;
5. exact code location that would change after approval.

**Do not implement the unresolved predicate unless it is already unambiguously dictated by authoritative evidence and existing user-approved V5 rules.**

Then stop.

---

# WORKSTREAM 2 — RESTART CONTINUITY

## Target
Define the minimum continuity mechanism required to resume broker-owned V5 contracts after restart.

## Objective
Preserve the approved rule that every filled contract retains its own actual entry basis and current profit-protection state without recreating V4 durability architecture.

## Scope
Luna may:

- inspect `positions.mjs`, `runtime.mjs`, and Alpaca current-position/order APIs;
- determine exactly what information Alpaca can and cannot provide after restart;
- enumerate the minimum V5 state that cannot be recovered from broker state alone;
- distinguish information required for correctness from information that is merely useful reporting;
- propose the smallest continuity representation capable of restoring normal per-contract evaluation.

Focus only on fields actually required by existing approved behavior, such as where applicable:

- contract identity;
- actual entry basis;
- current protected floor / arm state;
- remaining owned quantity;
- already-latched SELL state/current logical SELL identity if required.

Do not assume those exact fields are all necessary. Prove the minimum.

## Do not
- build a database;
- add Valkey;
- create reconciliation or historical lineage machinery;
- use aggregate broker average price as a substitute unless it is demonstrably equivalent to the approved per-fill behavior;
- reset armed floors on restart;
- implement a continuity method before the user approves the proposed mechanism.

## Deliverable
Return:

1. what broker state can reconstruct;
2. what broker state cannot reconstruct;
3. the smallest continuity state actually required;
4. where it would live and when it would be written/read;
5. ELI5 restart flow;
6. one recommended minimal design for user approval.

No implementation of the unresolved continuity mechanism.

Then stop.

---

# WORKSTREAM 3 — REAL ALPACA PROVIDERS WITHOUT POLICY INVENTION

## Target
Complete the neutral provider boundaries required by WS1–WS4 without resolving blocked policy choices.

## Objective
Replace simulated provider inputs with real Alpaca-facing implementations where behavior is already approved.

## Scope
Implement only provider/transport pieces whose semantics are already fixed:

- SIP stream transport for raw SPY trade events;
- OPRA option quote transport;
- Alpaca trade-update transport;
- authoritative Alpaca trading-calendar provider;
- 0DTE option-contract discovery provider;
- quote retrieval/normalization required by existing entry/position modules.

The provider must expose unresolved situations upward rather than deciding them.

Examples:

- SIP transport emits normalized raw trade data but does not invent eligibility filtering.
- Contract discovery may return an explicit ATM tie condition rather than choosing a strike.
- OPRA transport supplies bid/ask events but does not change spread policy.
- Calendar provider supplies actual open/close/session data but does not change 09:32 or 15:30 strategy rules.

## Do not
- submit orders;
- deploy;
- alter entry or exit policy;
- invent ATM tie-breaking;
- implement hidden retry/recovery frameworks;
- add generalized provider abstractions beyond what the current modules require.

## Verification
Use bounded non-ordering verification:

- connection/authentication where available;
- decoding of representative real responses or safely captured provider data;
- provider normalization into current V5 interfaces.

No broker order submission.

## Deliverable
Implementation plus:

- exact provider interfaces;
- what was exercised against Alpaca;
- what remains simulated;
- concise ELI5.

Then stop.

---

# WORKSTREAM 4 — RUNTIME / DAY LIFECYCLE COMPLETION

## Target
Complete the parts of `runtime.mjs` that are independent of the unresolved SIP, continuity, and ATM-tie policies.

## Objective
Finish the thin session lifecycle around the already-working trading loop.

## Scope
Implement only already-approved mechanics:

- authoritative calendar integration;
- startup session determination;
- fresh 30-second observation requirement after startup/reconnect;
- first-entry eligibility at 09:32 ET;
- no new entry at/after 15:30 ET;
- 5-second post-FLAT monotonic cooldown;
- normal next-trading-day rollover;
- fresh ledger identity for each trading date;
- finalization of the prior day's human-readable ledger;
- reporting/ledger failures must not become trading authority;
- clean waiting state between sessions.

Keep explicit blockers for:

- unresolved SIP eligibility;
- broker-owned restart exposure lacking approved continuity state;
- unresolved ATM tie.

## Do not
- force-flat at close;
- add close liquidation;
- add historical reconstruction;
- add reconciliation gates;
- add persistence beyond anything already approved;
- silently bypass unresolved startup ownership;
- deploy or run live PAPER trading.

## Verification
Use focused local/runtime simulation to prove only:

- normal trading-day open transition;
- 09:32 eligibility;
- 15:30 new-entry suppression;
- cooldown boundary;
- next valid Alpaca trading-day rollover;
- ledger identity rollover;
- unresolved states remain blocked explicitly rather than fabricated.

## Deliverable
Implementation, focused verification, and concise ELI5.

Then stop.

---

# Astra integration duties

When the four Luna streams return:

1. Review each strictly against its assigned scope.
2. Reject any invented policy, unrelated fix, architecture expansion, or strategy change.
3. Integrate only completed work that does not depend on unresolved user decisions.
4. Run the smallest existing focused checks needed to ensure integration did not break approved behavior.
5. Do **not** send PAPER orders.
6. Do **not** deploy.
7. Do **not** continue into another work phase.

Return one concise integration report with:

- **Implemented and verified**
- **Evidence gathered**
- **Decisions still requiring Joe**
- **Exact remaining blocker before first real PAPER validation**
- **ELI5 of the new runtime state**

Do not provide optional improvements, backlog items, speculative edge cases, or next-generation architecture.

# Stop condition

Stop when these four bounded streams are complete and integrated as far as current authority permits.

Astra does not have authority to resolve ambiguity itself.

If a decision affects strategy behavior, continuity semantics, or interpretation of user intent, stop that specific path and surface the decision clearly.