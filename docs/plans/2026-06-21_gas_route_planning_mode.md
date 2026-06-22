# PRD: Gas & Route Planning Mode (Stalagmight #38)

> **Status:** Draft for review · **Issue:** [#38](https://github.com/Stalagmight/Stalagmight/issues/38)
> (`enhancement`/`P3`/`planning`) · **Owner:** Nico · **Deco:** out of scope (separate future issue)
>
> **This is a living artifact.** Hand-edit freely — strike what's wrong, add cave-diver
> reality I've missed, re-rank the phases — and hand it back; I'll reconcile against the
> code and keep the file:line seams honest. The phased plan at the bottom is the part that
> becomes PRs.

---

## 1. Context & the reframe

Issue #38 is a deliberate stub: *"A planning mode for efficient dive plans: gas map and
deco from an arbitrary entrance to a lead. Large scope — needs its own spec/PRD."* This is
that PRD.

**The reframe that drives everything (Nico):** this is **not** "given a route, compute the
gas." It is **route-finding under a gas / bailout constraint** over the cave survey graph.
The headline interaction is the *inverse* problem — *"given my gas, how far can I get, and
where do I turn?"* — drawn on the actual surveyed line.

That reframe collapses the whole feature onto **one primitive**: a **gas-weighted
shortest-path** over the graph Stalagmight already builds. Reachable frontier, turn point,
"is this lead in budget," CCR bailout volume, and stage/bailout drop points are all
*projections of a single gas-Dijkstra field*. Designing around that primitive is what keeps
the phases small and the OC/CCR/team engines shared.

### North star (beyond this PRD): diver fan-out
Once the engine yields a per-diver gas-reachability field, Stalagmight can offer a **diver
fan-out strategy** for further **exploration or resurvey**: allocate divers/teams to leads
to maximize *new* passage covered (exploration) or *re-covered* passage (resurvey) subject
to each diver's gas/bailout budget. That is a coverage/assignment problem layered on the
per-diver fields — see §9. We don't build it now, but the core primitive (reachability
field) and the team-shaped data model are chosen so it's a natural later consumer, not a
rewrite.

---

## 2. Goals / non-goals

**Goals (the destination, phased in §8):**
- Survey-driven **reachable frontier + turn point** for open-circuit penetration (thirds).
- **CCR bailout**: OC bailout volume to exit a lead, and where to stage/drop bailout.
- **OC stage gas** + drop points (suggested *and* draggable-validated).
- **Team-aware**: matched gas / weakest-link reserve / CCR team bailout sharing.
- **DPV** modelled with **range / burn-time + dead-scooter contingency**.
- **Both unit systems** (metric bar/L, imperial psi/cuft), user-selectable.

**Non-goals (now):** decompression planning; gas-mix / MOD / END (arrive with deco);
agency-specific staging *presets* (the engine is parametric; presets are later);
multi-diver fan-out optimization (north star, §9).

---

## 3. Confirmed product decisions

| Fork | Decision |
|------|----------|
| MVP math | **Both** OC + CCR on a shared engine (destination; phased — see §8) |
| Survey coupling | **Survey-driven** (real depth-vs-distance profile; overlays on the line) |
| Config | **Opinionated default + key knobs** (thirds fraction, stressed-RMV ×, swim/DPV speed) |
| Plan unit | **Team-aware** (matched / weakest-link / CCR sharing) |
| Primary affordance v1 | **Reachable frontier** (lead→plan is the same field, other direction) |
| Gas units | **Both, user-selectable** |
| DPV | **Speed + range/burn-time + dead-scooter contingency** |
| Drop points | **Suggested *and* draggable-validated** |

---

## 4. The core engine — gas-weighted shortest path

The domain layer is **already factored for this** — we extend, not rebuild:

- `Project::build_survey_graph(n, station_index, coords)` (`src-tauri/src/models/project.rs:7363`)
  → adjacency `Vec<Vec<(usize,f64)>>`. Edges = all shots (incl. jump/reference) + zero-cost
  station merges + zero-cost loop closures.
- `Project::dijkstra(adj, roots)` (`project.rs:7426`) — generic over **any non-negative edge
  weights**, multi-source, `∞` for unreachable. Gas costs are non-negative ⇒ reused verbatim.
- `compute_distances_from` (`project.rs:7492`) literally names *"a future gas-planning mode"*
  as a target consumer; `distance_field_from` → `DistanceField {distances, station_refs,
  max_reachable}` (`project.rs:7541`) is the exact shape to mirror.

**Gas edge cost** = `gas_rate(avg_depth) × (edge_length / speed)`, where
`gas_rate(z) = RMV × ATA(z)`, `ATA(z) = 1 + max(z,0)/10` (10 msw ≈ 1 bar),
`z = Coordinates.z` (meters, **positive-down**, `station.rs:228`, set at `project.rs:3314`).
`avg_depth = ½(z_from + z_to)` — trapezoidal mean over a straight leg, cheaply available
from the measured station list (no extra survey walk). Merges/closures stay 0-cost (same
physical point ⇒ 0 gas — correct).

**Why it's cheap & correct:** reachability/distance is **coordinate-independent** (closure
adjustment only nudges coords sub-meter), so the gas engine consumes the **instant** measured
coords (`compute_station_coordinates()`, `project.rs:6758`) and **never** triggers the slow
~2 s/~40 s closure solve. This mirrors the existing `AppState::distance_field` decision
(`app_state.rs:364`), which already rejects the adjusted solve for the same reason.

**Everything derives from the field:**
- *Reachable within thirds* = stations whose **round-trip** gas ≤ usable·reserve_fraction.
  The turn frontier is a threshold on the field (reachable stations with an unreachable
  neighbor — one pass over `adj`).
- *Turn point toward a lead* = furthest point on the path where one-way gas = turn pressure.
  (Store a predecessor array in the Dijkstra loop at `project.rs:7460` to back-trace paths.)
- *CCR bailout / dead-scooter exit* = a **second** Dijkstra seeded **from the lead** toward
  the zero-datum exits, with **exit-leg weights** (stressed RMV; swim speed, since you bail
  off the scooter). The bailout "integral" is just that path's accumulated weight — no
  separate integration code.

---

## 5. Domain model (the gas math)

Canonical **SI internally** (liters, bar, meters, L/min); convert only at the IPC/format
boundary (mirrors how the codebase stores meters and converts in `formatStats.ts`).

```
Diver { rmv_l_per_min: f64, label: Option<String> }
  // RMV is canonical. SAC is a CONSTRUCTOR concern, never stored:
  // Diver::from_sac(sac_bar_per_min, ref_cyl) => rmv = sac * ref_cyl.water_volume_l.
Cylinder { water_volume_l, working_pressure_bar, fill_bar }
GasConfig {
  reserve: ReserveRule,          // Thirds(1/3) | Sixths(1/6) | Custom(f in 0..1)
  stressed_rmv_multiplier: f64,  // bailout/contingency bump, e.g. 1.5–2.0
  swim_speed_m_per_min: f64,     // default ~10
  dpv: Option<DpvProfile>,       // speed + burn-time/range (Phase 4)
  units: GasUnits,               // metric | imperial (display only)
}
enum PlanMode { OpenCircuit, CcrBailout }
Team { divers: Vec<Diver>, cylinders_per_diver: Vec<Vec<Cylinder>>, mode: PlanMode }
```

- **RMV canonical, SAC never persisted** — enforce in the type system (no `sac` field; only
  `from_sac`). Every `f64` ingress gets a finite+positive guard returning `Result<_,String>`
  (follow `Coordinates::new_checked`, `station.rs:245`) — a NaN speed or zero cylinder would
  poison the whole field, and the anti-slop clippy policy forbids `unwrap`/`panic` in prod.
- **Team/Vec shape exists from day one** so CCR (Phase 3) and team (Phase 5) add **no
  migrations** — Phase 1 just collapses to one diver, one cylinder.

---

## 6. ⚠ Safety posture (this tool informs life-support decisions)

A dive planner outputs numbers people stake their lives on. The PRD treats this as a
first-class constraint, not a footnote.

- **Conservative rounding:** gas *requirements* round **up**, reachable extent rounds **down**.
- **The #77 jump-vs-reference problem becomes safety-critical here.** `build_survey_graph`
  deliberately favors *completeness* and includes non-swimmable reference ties, with a
  documented residual risk (`project.rs:7358`) that a *non-swimmable* reference shortcut
  **understates distance**. In the distance gradient that just mis-colors a station. **In a
  gas/bailout planner it under-plans the dive** — the dangerous direction. So for gas routing
  we likely want to **exclude non-swimmable references** (jumps DO count — they're swimmable).
  This pulls the first-class jump/reference model (**#77**) in as a real dependency, or at
  minimum a gas-graph-specific edge filter. **Open question for Daniel** (owns the geometry
  layer) — see §10. *I diverge from the architecture draft here, which treated this as
  "inherited for free"; topologically yes, but the safety implication says otherwise.*
- **Framing:** the UI is a planning aid, not an authority — show assumptions; never a single
  unlabelled "you're fine" number.

---

## 7. Architecture

### 7.1 Backend (Rust) — new `src-tauri/src/core/gas/`
Registered in `core/mod.rs` (pure domain math over a graph snapshot — belongs by the other
topology compute, not in `models/`). Files: `mod.rs` (public `plan_gas_reach` /
`plan_to_lead`), `model.rs` (TS-deriving model + IPC structs), `physics.rs` (pure
`ata`/`gas_rate`/`edge_gas` — golden-tested), `engine.rs` (gas-Dijkstra → `GasReachField`,
CCR exit integral, OC stage/thirds, team reduction), `tests.rs`.

- **Factor the weight out of `build_survey_graph`.** Today the weight choice is baked into one
  `match coords` (`project.rs:7380`). Generalize to a closure —
  `build_survey_graph_weighted<F>(…, weight: F)` — and make the current `build_survey_graph`
  a thin wrapper passing the existing length/straight-line closures, so the **four existing
  distance callers are behavior-preserving**. The gas engine passes a closure capturing
  `(rmv, speed, &coords)`.
- **`GasReachField`** (mirror `DistanceField`, JSON-safe `Option` for `∞`):
  `{ station_refs, gas_to_reach: Vec<Option<f64>>, reachable: Vec<bool>,
  turn_frontier: Vec<StationRef>, max_reachable_gas, budget_litres }`.
- **Caching: don't (yet).** A measured-coords gas Dijkstra is O(E log V) — milliseconds even
  at 6k stations; the expensive thing is the closure solve, which we never call. Ship Phase 1
  with a **frontend debounce** (150–250 ms) on the param sliders. Add a single-slot
  `AppState` memo (key = `modified_at` + **origin** + **gas-params hash**) only if a large
  survey stutters — note the key needs the params hash, unlike distance.
- **IPC** (`commands/gas.rs`, modeled on `get_station_distances_from`, `commands/project.rs:128`;
  `spawn_blocking`, one reconciled snapshot): `compute_gas_reach_field(origin?, gas_config,
  team, mode)` and `compute_gas_plan_to_lead(origin?, lead, …)`. Delegate to `AppState`
  methods that call `compute_station_coordinates()` (measured) — **never**
  `get_adjusted_stations()`. Register in `tauri::generate_handler!` (`lib.rs:1242`).
- **ts-rs**: all IPC structs `#[derive(TS)]` → regen via `pnpm gen:ipc-types`; never hand-edit
  `src/types/ipc/`.
- **Telemetry** (append-only/frozen registry): add `command.compute_gas_reach_field` /
  `command.compute_gas_plan_to_lead` to `telemetry/registry.rs` + mirror in
  `src/utils/telemetry.ts` (read-only query commands → **not** in `UNDOABLE_COMMANDS`). The
  `registry_covers_all_commands` test (`registry.rs:571`) is CI-gated under `--features
  telemetry` and will fail if missing.
- **Lints/format are CI gates:** no `unwrap/expect/panic` in prod gas code; per-test-module
  `#[expect]` for the math tests; `cargo fmt` + clippy before pushing (`docs/linting.md`).

### 7.2 Frontend (TS/React) — a single-view sub-mode, NOT a new top-level view
Recommended after evaluating both. A third `ViewType` (`uiStore.ts:25`, branch at
`App.tsx:578`) would **re-mount its own map**, losing survey layers/camera/GPS origin. Gas
planning wants the *same* `MapCanvas` + overlays + a panel — exactly the distance-gradient
shape (a runtime-only flag + origin + fetched field, reset on view switch).

- **`uiStore` additions** (model on the distance-gradient block, `uiStore.ts:330`/`:855`):
  a `gasPlanActive` sub-mode flag; add `exitGasPlan()` to the `setView()` cleanup funnel
  (`uiStore.ts:487`, beside `exitSectionFocus()`/`exitDataTableFullScreen()`) so a stale gas
  overlay can't outlive a project switch or a return to global view. Suppress the
  depth/distance/severity gradients while active (they paint the same shots layer) — runtime
  flags only, like `toggleDistanceGradient`.
- **`src/store/gasPlanStore.ts`** (new, mirrors `globalViewStore.ts`): `gasConfig` (seeded
  from `Config.gas`), `team`, `mode`, `origin`, `selectedLead`, `reachField`, `leadPlan`,
  `userDrops` (Phase 2). Setters **null the result on input change** (mirror
  `setDistanceGradientOrigin` clearing `distanceField`) so stale colors never show under a
  new legend. `reset()` called from `exitGasPlan()`.
- **IPC effects** (model on the distance fetch, `MapCanvas.tsx:1738`): `let cancelled` guard;
  **debounce** the `gasConfig` dep; deps include `project?.modified_at`; **also** capture
  `projectIdentityKey(project)` (`useMapTools.ts:24`) at request time and drop stale replies
  on project switch — stronger than distance's `modified_at`-only guard, because a selected
  lead persists across more interactions.
- **Map overlays** (`MapCanvas.tsx:3312`/`:3341` region, runtime-only, reset on switch):
  reachable-extent feature-state (`utils/gasReach.ts`, sibling of `utils/distanceGradient.ts`);
  turn-point marker (MapLibre `Marker`, `MapCanvas.tsx:1787`); selected-lead path tint (reuse
  `setMeasuredPath`, `:1768`); drop markers (Phase 2). A `GasLegend.tsx` mirrors
  `DistanceLegend.tsx`.
- **Input panel + readout** (in `SingleSystemView`, entry via a `DisplayMenu` item like the
  other analytical overlays): origin picker (reuse the map-click station pick that drives
  `setDistanceGradientOrigin`), RMV/SAC, swim/DPV speed, reserve fraction, stressed ×, OC/CCR
  toggle, cylinder editor; readout of budget, max penetration, turn pressure per cylinder, and
  (lead selected) gas-to-reach + within-budget.
- **Gas units**: new `Config.gas` block (`config/types.rs:9`, `#[serde(default)]` like the
  other newer blocks — **bundle gas units in `GasConfig`, don't bloat `UnitsConfig`**); seed
  the TS default at `src/types/config.ts` alongside `units:`; add `src/utils/formatGas.ts`
  (`formatPressure`/`formatVolume`/`formatRmv`, metric path first, conversion seam in place so
  imperial is a Phase-4 flip, never hardcoded suffixes at call sites); extend
  `settings/UnitsSettings.tsx` with a gas sub-section.

---

## 8. Phasing (epic → shippable slices)

> Interpreting "both in MVP": **both OC and CCR are the destination**, but they are *not* one
> PR. They share the engine, yet they couple three independent risk surfaces (gas-Dijkstra
> correctness; exit-integral + drop validation; team reduction). Phase 1 ships the slice that
> *forces the engine to exist correctly* and is independently useful; the data model is built
> CCR/team-shaped from day one so later phases add no migrations. Re-rank these freely.

- **Phase 0 — Foundations (no UI):** `Config.gas` + gas units + `formatGas.ts`; the gas
  domain model + SAC→RMV; `core/gas/{physics,model}.rs` with golden unit tests. Small, safe,
  fully testable in isolation.
- **Phase 1 — OC reachable-frontier (headline):** the `build_survey_graph_weighted` refactor;
  `GasReachField` + `compute_gas_reach_field`; sub-mode shell (enter/exit + `setView` reset),
  single-diver input panel, reachable-extent overlay + turn point + readout; `gasPlanStore`.
  Single diver, both unit systems. **First user-visible vertical slice.**
- **Phase 2 — Lead→plan + OC stages + drops:** `compute_gas_plan_to_lead` (back-traced path),
  stage gas, turn pressures, suggested + draggable-validated drops, drop markers.
- **Phase 3 — CCR bailout:** `PlanMode::CcrBailout`, bailout volume (exit-from-lead, stressed
  RMV, swim speed), bailout staging + drops. Reuses 100% of the engine.
- **Phase 4 — DPV range/burn-time + dead-scooter contingency; imperial units flip.**
- **Phase 5 — Team:** matched gas, weakest-link reserve, CCR team bailout sharing (a `fold`
  over per-diver fields — no new graph math).
- **Dependency to schedule early:** the **#77** gas-graph edge filter (safety, §6) — needed
  before Phase 1 ships numbers anyone trusts.
- **Each phase = its own PR off `master`**, small semantic commits, `/pre-pr` before each,
  tests included. Don't self-merge.

---

## 9. Future directions (where this could go)

- **Diver fan-out for exploration / resurvey (the north star).** Given per-diver
  `GasReachField`s, recommend an **allocation of teams to leads** maximizing an objective —
  *new* passage reached (exploration) or *re-covered* passage (resurvey) — subject to each
  diver's gas/bailout budget and shared-staging logistics. It's a coverage/assignment problem
  on top of the reachability fields (think: weighted set-cover / orienteering over the graph).
  The engine primitive (the field) and the team-shaped model make this additive, not a
  rewrite.
- **Deco planning** (the other half of #38) — depth-time profile from the chosen route → stop
  schedule → gas-by-mix. Needs gas mixes / MOD / END, which arrive together.
- **Agency staging presets** — canned `GasConfig`s (GUE-style, NSS-CDS, etc.) over the
  parametric engine.
- **What-if & logistics** — "if I add an AL80 stage, how much further?"; pre-place / retrieval
  ordering; multi-day push staging.

---

## 10. Open questions
1. **#77 / safety (for Daniel):** first-class jump-vs-reference model, or a gas-graph-only
   edge filter excluding non-swimmable references? Blocks trustworthy Phase 1 numbers (§6).
2. **Staging-philosophy default:** thirds-on-stage vs all-stages-first for the single shipped
   default (knob/presets later).
3. **Memoization:** confirm "debounce-only" holds on the largest real survey, or add the
   single-slot memo (§7.1).
4. **DPV gas effect:** model a *lower* RMV on the scooter (reduced workload), or speed-only?

---

## 11. Verification
- **Rust (gated `--features telemetry`):** golden-fixture unit tests in `core/gas/tests.rs` —
  hand-computed `ata`/`gas_rate`/`edge_gas`; a 3–4 station survey with known depths where the
  thirds round-trip budget is hand-computed, asserting `reachable[]`, `turn_frontier`,
  `gas_to_reach[lead]` to tolerance. **Adversarial:** empty/no-zero-datum project (→ all
  unreachable, like `compute_penetration_distances`, `project.rs:7514`), disconnected lead,
  merge/closure on the path (0-cost), a jump shortcut (counts), a non-swimmable reference
  (must NOT shortcut gas — §6), near-zero/above-surface depth (`ata` clamps).
- **Frontend:** vitest for store + unit conversions; Playwright `@smoke` for enter/exit +
  reachable-overlay render-and-reset against mocked IPC (mirror the distance-gradient e2e).
- **Manual/e2e:** load a real `e2e/fixtures/*.dmp`, enter the mode, check the reachable
  frontier + turn point against a hand calc.

## 12. Critical seams (file:line)
- `src-tauri/src/models/project.rs` — `build_survey_graph:7363`, `dijkstra:7426`,
  `compute_distances_from:7492`, `distance_field_from:7541` (factor the weight closure; add
  predecessors), `coords.z = compute_station_depth():3314`.
- `src-tauri/src/core/state/app_state.rs` — `distance_field:364` (measured-coords precedent),
  `adjusted_cache:44` (mirror-or-skip).
- `src-tauri/src/commands/project.rs:128` — `get_station_distances_from` (the command template).
- `src-tauri/src/config/types.rs:9` — `Config` (add `gas`); `:779` `UnitsConfig` (leave alone).
- `src-tauri/src/models/station.rs:228` — `Coordinates.z` (depth, +down); `:364` `ZeroDatum`.
- `src/components/Map/MapCanvas.tsx` — distance fetch `:1738`, feature-state `:1753`, origin
  marker `:1787`, overlay region `:3312` (the overlay template).
- `src/store/uiStore.ts` — `ViewType:25`, `setView` cleanup `:487`, distance-gradient sub-mode
  `:330`/`:855` (the sub-mode + reset template).
- `src/utils/formatStats.ts:53` — `formatLength` (template for `formatGas.ts`).
