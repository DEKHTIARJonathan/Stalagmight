# Repro & injection harness: force hypothesized races instead of arguing about them

Status: DRAFT for maintainer review - strata L1/L2 are design-only until reviewed.
Tracking: #365. Prior art in-tree: `docs/agent-harness.md`, `docs/collab-stress-testing.md`,
`docs/debug-gates.md`.

## Problem

Review and testing keep producing *plausible* timing hypotheses - a stale async IPC
reply painting after a project switch, an ordering window between a state write and its
consumer, a rare interleaving under load - that die unverified, because nothing can hold
the race window open. Blind iteration does not fix this: at a realistic budget
(~10k iterations) a genuinely timing-dependent bug still hides, and a failed soak reads
as evidence of absence when it is only underpowered.

The fix is the closed-loop principle the agent harness is already built on: give the
tester **control** (make the hypothesized schedule forceable) and **visibility**
(oracles that trip when an invariant breaks). A claim about failure behavior is only
proven by demonstrating the failure - the same principle behind our
inject-the-bug test-vacuity checks, applied one level up: injection tests validate the
detector; injection hooks validate the hypothesis; the same forcing with the fix in
place validates the fix.

## The strata

"Below the UI" is not one place. Four strata, with opposite trade-offs:

| Stratum | What | Speed/iter | Schedule control | Fidelity | Drift risk |
|---|---|---|---|---|---|
| **L0** frontend | vitest + fake timers + unit IPC mock | ms | total (fake clock) | frontend only | mock drift (#277 class) |
| **L1** core | in-process Rust: drive `AppState::execute` / command fns with scripted or generated command sequences | us-ms | total (seeded RNG, injected clock, exact op order) | core only - no IPC serialization, no command-lock path, no frontend | none (real code) |
| **L2** IPC boundary | `tauri::test` mock runtime: real handlers, real state, real serialization + command lock, no webview | ms | high (ordered invokes, forced overlap) | everything but the DOM | low |
| **L3** whole app | existing agent harness (`driver_script`, `run_scenario`) | ~0.5-2s | low (natural timing + injection hooks) | full | n/a |

At 10k iterations: L1 = seconds, L0/L2 = minutes, L3 = hours (last resort, not default).

## Routing table (bug class -> stratum)

| Hypothesis class | Stratum | Forcing mechanism |
|---|---|---|
| Stale async IPC reply / version-guard (`projectIdentityKey`) | L0 | fake timers + controllable promise resolution |
| Geometry-readiness vs identity guard (measured->adjusted swap without `modified_at` bump) | L0 | same |
| Command-lock ordering, hung-IPC deadlock, reply overlap | L2 | ordered/overlapping invokes |
| Core invariants: undo round-trip, reconcile idempotence, persistence atomicity, section-scoped keying, collab reconcile | L1 | scripted/generated command sequences |
| Emergent whole-system (render + IPC + persistence together) | L3 | injection hooks below |
| Load-dependent UI flake | L3 / Playwright | existing flake protocol (`--repeat-each`, workers) |

A repro request that names its mechanism names its stratum. Anything reproducible at a
lower stratum must be forced there, not soaked at a higher one.

## App-side injection hooks

The marginal investment goes into the app, not the driver: observability and control
points inside the system under test. All gated on `STALAGMIGHT_TEST_HOOKS=1`
(compiled-in but inert otherwise), following the `debug_trigger_panic` precedent
(`src-tauri/src/commands/debug.rs`). Candidates, smallest first:

1. `debug_delay_command(command, delay_ms)` - hold the next reply for a named IPC
   command by N ms: turns every stale-reply hypothesis into a first-try repro at L3.
2. `debug_drop_next_reply(command)` - the lost-reply variant.
3. Injectable clock for `modified_at` (L1): lets scenarios force the
   identical-timestamp and stale-identity edges deterministically.

Not proposed: a general scripting language inside the app. Scripts live in the test
layers; the app only exposes narrow, named control points.

## Two loops over one mechanism

**Review-repro loop** (targeted, interactive, small n): a review finding names a
mechanism; the tester picks the stratum from the routing table, forces the schedule,
and returns CONFIRMED with a replay/regression test, or NOT REPRODUCED with the
iteration count and forcing used stated. A negative without its N and forcing is not
reportable. Invoked ad hoc (agent or human); no new server - L0/L1/L2 are just test
code, L3 is the existing MCP harness.

**Discovery loop** (broad, unattended, high n): generated command sequences + oracles.
Runs as `cargo test` at small n inside the normal gate, and a nightly job at ~10k with
a printed seed so any failure replays exactly. No interactive agent in the loop - the
agent's job is writing generators/oracles beforehand and triaging findings afterwards.
At L1 this is property-based testing; the first oracle is the strongest one we know:
*execute a random command sequence, undo all of it, assert the project is
value-identical to the start* (plus `check_project_integrity` and the existing
`#[cfg(debug_assertions)]` cross-checks along the way).

## Finding triage - two tiers

- **Bug**: the failing sequence is traced to a producible UI/IPC path.
- **Hardening**: the sequence is not known to be producible by the real frontend
  (arbitrary-order robustness). Filed separately, batched, low priority - real signal
  for the open-source flip, but never mixed into the bug stream.

## Decisions taken (2026-07-30)

- L0 starts immediately (no new surface needed) - first target is the stale-reply
  guard class, injection-proved (guard disabled -> test goes red).
- Among the lower strata, **L1 first**: fastest iterations, zero mock drift, and the
  discovery loop falls out of it nearly for free. L2 follows if/when the
  lock/ordering class needs it.
- Discovery runs under cargo + nightly, not under the MCP harness.
- Two-tier triage as above.

## Open questions for review

1. L1 scenario format: proptest-generated sequences, hand-written JSONL scenarios
   replayed by a test-only runner, or both (proptest for discovery, JSONL for repro)?
2. Which core invariants rank first as oracles beyond undo round-trip -
   reconcile idempotence? persistence save/load round-trip? merge/closure FK integrity?
3. Any objection to `tauri::test` as the L2 vehicle, or is there a better seam at the
   command-lock layer?
4. Hook surface: are the three candidates above the right first set, and should the
   delay hook live at the invoke boundary or inside specific commands?

## Out of scope

- L1/L2 implementation (this doc is their design review).
- Changes to the agent-harness MCP surface.
- Any always-on runtime cost: every hook is `STALAGMIGHT_TEST_HOOKS`-gated and every
  new loop runs in test layers only.
