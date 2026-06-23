# PRD: Gas & Route Planning Mode (Stalagmight #38)

> **Status:** Draft for review · **Issue:** [#38](https://github.com/Stalagmight/Stalagmight/issues/38)
> (`enhancement`/`P3`/`planning`) · **Owner:** Nico · **Deco:** out of scope (separate future issue)
>
> **This is a living artifact.** Hand-edit freely — strike what's wrong, add cave-diver
> reality I've missed, re-rank the phases — and hand it back; I'll reconcile against the
> code and keep the file:line seams honest. The phased plan at the bottom is the part that
> becomes PRs.
>
> **⏸ Implementation hold (2026-06-23).** A Rust refactor is in flight on the other clone
> (`~/src/Stalagmight`). **Planning continues; implementation waits** until it lands. The
> file:line seams in §7/§12 are pinned pre-refactor — the design rides the *public* graph /
> Dijkstra primitives so it should survive, but exact lines and the `build_survey_graph`
> factoring may move, so every seam gets re-verified before any code is written.

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
**traverses** (in one entrance, out another — they need 2+ setup dives and violate §6's
"exit the way you came"); agency-specific staging *presets* (the engine is parametric; presets
are later); multi-diver fan-out optimization (north star, §9).

---

## 3. Confirmed product decisions

| Fork | Decision |
|------|----------|
| MVP math | **Both** OC + CCR on a shared engine (destination; phased — see §8) |
| Survey coupling | **Survey-driven** (real depth-vs-distance profile; overlays on the line) |
| Config | **Opinionated default + key knobs**; reserve = **3 presets** (All-thirds default; pushy 1-/2-stage gated to advanced — see §5.1) + stressed-RMV ×, swim/DPV speed |
| Plan unit | **Team-aware** (matched / weakest-link / CCR sharing) |
| Primary affordance v1 | **Reachable frontier** (lead→plan is the same field, other direction) |
| Gas units | **Both, user-selectable** |
| DPV | **Speed + range/burn-time + dead-scooter contingency**; **same RMV as swimming** (no reduced-RMV credit — §10) |
| Drop points | **Suggested *and* draggable-validated** — tool gives the gas-feasible envelope; diver places for landmark / environment / mission (§5.4) |
| Survey reserve | **Total-thirds** invariant (movable across cylinders); **asymmetric** slow-in/fast-out gas; **not opinionated on survey** — show the thirds line, allow knowing over-penetration (§5.2) |
| Plan persistence | **Ephemeral** — never written to the `.stalx` (.stalx = the *cave*; a plan is the *team/dive*). Personal *defaults* (RMV, tank presets, reserve preset) may live in **user config**, not the project. **Print-out** is a wishlist output (§9) |

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
- *Reachable within budget* = stations whose **round-trip** gas ≤ usable gas after the §5.1
  reserve rule. **Round-trip is asymmetric** when surveying: `gas_in(X | survey speed) +
  gas_out(X | swim speed)`, i.e. two Dijkstra fields (the OUT field is the same exit-leg field
  CCR bailout needs), **not** one field doubled — see §5.2. **The exit follows the entry path
  reversed, never an alternate/shorter unswum route** (§6, "exit the way you came"). The turn
  frontier is a threshold on the field (reachable stations with an unreachable neighbor — one
  pass over `adj`).
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
Cylinder { water_volume_l, rated_pressure_bar, fill_bar, material: TankMaterial }
  // fill_bar is an INPUT and may EXCEED rated — overfilling is routine (LP85s @ 210–230 bar,
  // §5.3); rated is reference only, NEVER a clamp. material (Alu|Steel) hints stage-vs-backgas.
GasConfig {
  reserve: ReservePreset,        // AllThirds | OneStage | TwoStage — see §5.1; pushy presets gated to "advanced"
  stressed_rmv_multiplier: f64,  // bailout/contingency bump, e.g. 1.5–2.0
  swim_speed_m_per_min: f64,     // EXIT-leg speed (fast). DEFAULT 10 m/min (no DPV — Nico)
  survey_speed_m_per_min: Option<f64>, // IN-leg speed while surveying — often 2–3× slower; None = symmetric. §5.2
  survey_rmv_multiplier: f64,    // IN-leg task-loading bump; DEFAULT 1.0. New surveyors report a bit; minor. §5.2
  dpv: Option<DpvProfile>,       // speed + burn-time/range (Phase 4); SAME rmv as swimming, no reduction
  units: GasUnits,               // metric | imperial (display only)
}
enum PlanMode { OpenCircuit, CcrBailout }
Team { divers: Vec<Diver>, cylinders_per_diver: Vec<Vec<Cylinder>>, mode: PlanMode }
  // Dissimilar-tank team matching (common in Florida) = the LOWEST usable-volume diver gates
  // the team's turn; weakest-link = min over divers of usable gas. §5.3.
```

- **RMV canonical, SAC never persisted** — enforce in the type system (no `sac` field; only
  `from_sac`). Every `f64` ingress gets a finite+positive guard returning `Result<_,String>`
  (follow `Coordinates::new_checked`, `station.rs:245`) — a NaN speed or zero cylinder would
  poison the whole field, and the anti-slop clippy policy forbids `unwrap`/`panic` in prod.
- **Team/Vec shape exists from day one** so CCR (Phase 3) and team (Phase 5) add **no
  migrations** — Phase 1 just collapses to one diver, one cylinder.

### 5.1 Reserve presets & return-leg recalc (Nico's spec — captured verbatim)

Three selectable presets (pressures in **bar**; "turn at 1/N" = turn when 1/N of usable
gas is consumed):

| Preset | Back gas | Stage(s) |
|--------|----------|----------|
| **All-thirds** *(safe default)* | thirds | thirds on every stage |
| **1-stage** *(pushy — advanced only)* | **quarters** | stage 1 → `(½ × start_pressure) − 15` |
| **2-stage** *(pushy — advanced only)* | **sixths** | **both** stages → `(½ × start_pressure) − 15` |

*Terminology (Nico): **"cave side"** = further in (toward the lead); **"exit side"** = toward
the entrance.*

**Return-leg recalc** — gas spendable on a "side mission" (a lead poked into on the way out).
**Recalc requires a stage in hand** — you need spare gas to justify the detour — so it's
unavailable at max penetration and only opens up once you've retrieved a stage. Three regions
of the exit path (lead → exit):
- **Cave side of the stage-2 drop** (lead ↔ stage-2 drop): **no recalc** — no stage retrieved
  yet; governed by the initial **⅙ back-gas** reserve.
- **Between the stage-2 and stage-1 drops** (stage 2 retrieved): usable =
  `((current_backgas − 100) / 2) − 15`
- **Between the stage-1 drop and the entrance** (stage 1 also retrieved): usable =
  `((current_backgas − 70) / 2) − 15`

*(Reserve shrinks toward the exit — 100 → 70 bar of back gas held — because there's less cave
left to swim out; the `−15` is a fixed buffer on each. Corrected 2026-06-22.)*

**Pressure vs volume (Nico):** the engine computes in **volume** (liters — that's what
RMV×ATA consumes), but **turn points, reserves, and recalc outputs read as PRESSURE per
cylinder** (`bar = liters / water_volume_l`), because divers watch pressure gauges underwater.
Volume is the *planning* currency and the only sane way to gas-match dissimilar tanks. So:
canonical-volume internally, per-cylinder-pressure on every in-dive readout.

**Product gate:** the 1-/2-stage presets are *pushy* — expose them only behind an explicit
**advanced-diver acknowledgment**. They are **thirds-preserving** (§5.2): "advanced" means the
multi-cylinder gas-management skill to balance gas across tanks, **not** breaking the reserve.
**All-thirds is the default.** The recalc is a distinct compute path (it re-budgets from
*current* pressure mid-dive), so model `reserve` as a preset enum *plus* a
`recalc(position, current_backgas)` function, not a single fraction. **v1 caps at 2 stages** —
**≥3-stage** support (big OC pushes; increasingly rare as divers move to CCR) is **deferred to
a later phase**.

**Resolved (Nico):** "past" = **cave side**; `(½ × start) − 15` is a **pressure** (turn
pressure); the recalc regions/formulas are as above (corrected 2026-06-22 — recalc needs a
stage in hand, so the deepest region has none).

**⚠ Minor open:** confirm "turn at 1/N" = turn when 1/N of usable is *consumed* (the deepest
region's "⅙ back gas" reads as the sixths reserve, consistent with that reading).

### 5.2 Surveying changes the gas math — asymmetric speed + a less-opinionated reserve (Nico)

**Total-thirds is the invariant, not per-tank thirds.** The safety floor is **⅓ of *total*
gas reserved across all cylinders**. Gas can be **moved between cylinders** (Nico dives 2
back-gas + 2 stages) — you may run plain ⅓-per-tank, or balance gas across tanks; the balanced
scheme still preserves total thirds. The §5.1 presets are these thirds-preserving
distributions; the engine's hard floor is **total-thirds**, presets only change *where* gas is
spent.

**Survey-in is 2–3× slower than the swim-out.** Surveying is slow work; the exit is a fast
swim (default **10 m/min**, no DPV). So per-meter gas IN ≫ OUT, and **round-trip gas is NOT
2× one-way**: `round_trip(X) = gas_in(X | survey speed) + gas_out(X | swim speed)` — two
Dijkstra fields (in + out), the OUT field being the same exit-leg field CCR bailout needs.
**Optional in-leg RMV bump:** surveying *task-loads* the diver (reel, slate), which can raise
RMV a little — minor and individual (new surveyors report it; veterans don't), so it's an
**opt-in `survey_rmv_multiplier` slider** (default 1.0) on the IN leg only, never a baked-in
assumption.

**Consequence: strict thirds *under*-penetrates on survey.** Turning at "⅓ consumed" on the
slow way in leaves you surfacing with lots of unused gas and a shorter push than was safe — so
many surveyors knowingly push past nominal thirds on survey.

**⇒ The tool must NOT be opinionated here.** Show the strict-thirds turn point as a *reference
line*, **also** show the asymmetric gas-balanced reach (further in), and let the diver choose —
**this is a risk she calls herself.** Never hard-block penetration past thirds; label it, don't
forbid it. (Reinforces §6: planning aid, not authority.)

**Feature — "push headroom" (Nico wants this; handle with care per §6).** Because the tool
knows the real depth/distance profile *and* the slow-in/fast-out speeds, it can show how much
further a given total-thirds budget actually reaches vs the strict-thirds turn point — the calc
surveyors otherwise fudge in their heads. High value, but it is the single most
**over-trust-prone** number in the app; its presentation is governed by the automation-bias
rule in §6.

### 5.3 Tanks: presets, overfilling, and dissimilar-tank matching (Nico)

**Tank diversity is regional.** In **Mexico** it's mostly standardized AL80 / LP85 (below), so
dissimilar-tank matching rarely bites. In **Florida, all bets are off** — LP120, HP130, HP100,
LP106, … — and there **real dissimilar-tank team matching is needed.** The rule is simple, not
an optimization: **the lowest usable-volume diver gates the team** (everyone turns on the
smallest member). So this lives in the **Team feature (Phase 5)**, computed from each diver's
*actual* tank volumes — see §5 `Team` / §8.

Two common tanks — ship as presets:

| Tank | Water vol | Rated | Typical fill | Role |
|------|-----------|-------|--------------|------|
| **AL80** (aluminium) | 11.2 L | — | ~210 bar (≈ 80 cuft → the name) | stages **and** back gas |
| **LP85** (steel) | 12 L | ~2600 psi (~179 bar) | **210–230 bar, overfilled** | **back gas only** (negative buoyancy → poor stage) |

**Fill pressure is an INPUT, not the rating.** LP85s are routinely **overfilled to ~210–230
bar absolute** — i.e. filled *to* ~230 bar, **not** 230 over the ~179 bar rating. Not strictly
US-legal, but standard; safe data for newish steel passing hydro. The model takes `fill_bar`
as given and **never clamps it to rated** — rated is reference only. A 12 L LP85 @ 230 bar
holds well over an AL80's 80 cuft.

**"Call it an 80" — conservative convention, and an automation-bias trap.** Because they're
overfilled, divers often skip the dissimilar math and just call LP85s "80s" — *understating*
gas for a **more conservative** plan that won't break thirds. ⚠ So the *accurate* thing
(computing real gas from a 230-bar fill) is **less** conservative than the community norm.
Therefore: accept actual fill for honesty, but make the **derate / use-rated** treatment a
first-class, easy option, and don't let the tool's precision quietly erode the convention
(ties to §6 automation-bias).

**Buoyancy / role (minor):** steel ≈ negative → back gas; aluminium ≈ neutral → fine as
stages. Material can *hint* role suitability when assigning cylinders — guidance, not a hard
rule.

### 5.4 Stage drop points: a gas-feasible envelope, the diver places within it (Nico)

A drop point is **not** a single computed spot — it's **driven by both gas and location**, plus
judgment the tool can't have. So the tool computes the **gas-feasible envelope** (earliest
sensible drop ↔ the latest the gas allows for that stage's `(½·start) − 15` turn) and suggests a
default; the **diver places within it** and the tool **re-validates**. Why a diver moves it:
- **Landmarks** — drop at a findable feature (a T / junction), *especially when gas-marginal*,
  where divers deliberately drop **early** at a recognizable spot so they can relocate it.
- **Environment** — some places are bad to drop a stage (silt, delicate formations,
  restrictions); off-limits regardless of gas.
- **Mission profile** — **depth-first** (max linear penetration down one line) vs
  **breadth-first** (explore many leads in a branching cave) drive different placements.

⇒ The tool **shows the feasible range and validates the choice; it never prescribes the spot**
(another §6 "aid, not authority"). The depth-first/breadth-first axis is the same one the
fan-out optimizer reasons on later (§9).

---

## 6. ⚠ Safety posture (this tool informs life-support decisions)

A dive planner outputs numbers people stake their lives on. The PRD treats this as a
first-class constraint, not a footnote.

- **Conservative rounding:** gas *requirements* round **up**, reachable extent rounds **down**.
- **Jumps & references — #77 (Nico's call):** **jumps are swimmable → calculate their
  distances** and count them as real legs (they already carry a shot length). **Reference
  shots should resolve, and the shortest path is chosen** — keep the completeness-favoring
  graph and trust shortest-path (excluding edges only *over*-routes; shortest-path never
  double-counts). So **#77 is NOT a blocking dependency** and we do **not** filter reference
  edges out of the gas graph. The safety margin comes from **conservative rounding** (above) +
  the unreduced-RMV-on-scooter buffer (§10), not edge exclusion. *(Supersedes my earlier
  draft, which proposed excluding non-swimmable references — overcautious; Nico confirms
  references-resolve-then-shortest-path is correct for the real datasets.)*
- **Exit over the path you came in on (core cave rule — Nico).** Cave divers plan to exit via
  the *exact* route they entered. A mapped connection is **not** a guaranteed exit — lines get
  moved, repaired, or degrade; a 30-year-old survey link may be gone; a passage viable for one
  team (sidemount) may be impassable for another (backmount + scooters + stages). So while
  shortest-path is fine for *penetration* (#77 above), the **return leg = the entry path
  reversed** — the engine must **never** route the exit through a shorter/alternate connection
  the graph offers but the diver didn't swim. (Also why **traverses are out of scope**, §2.)
- **Framing:** the UI is a planning aid, not an authority — show assumptions; never a single
  unlabelled "you're fine" number.
- **Survey ≠ enforced thirds (§5.2):** the slow-in/fast-out asymmetry makes strict thirds
  *under*-penetrate, so show the thirds line as a reference and let the diver knowingly push
  past it — never hard-block. Reserve invariant = **total thirds across all cylinders**, not
  per-tank.
- **⚠ Automation bias — the headline UX-safety risk (Nico).** People put outsized trust in
  computer numbers, so the §5.2 "push headroom" is the most dangerous output we can show: a
  diver may read a *calculation* as *permission* and push past their training. Therefore:
  **(1)** strict thirds is the **default and visual primary**; extended reach is secondary and
  explicitly opted-into, never the headline. **(2)** Frame it as "what the gas math permits
  under these assumptions," **never** a recommended/target turn — no "you-could-go-further"
  copy, no green "safe" coloring of the aggressive zone, no gamifying max penetration.
  **(3)** Surface the **fragile assumption**: the extra reach exists only if the fast exit
  actually happens — an entanglement, lost line, buddy problem, or failed scooter on the way
  out erases it and the gas you already spent penetrating is gone. **(4)** Keep the
  conservative choice the path of least resistance; we don't normalize deviation from
  commonly-accepted practice.

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
- **Phase 5 — Team:** matched gas (dissimilar-tank matching = **lowest usable-volume diver
  gates**; common in Florida — §5.3), weakest-link reserve, CCR team bailout sharing (a `fold`
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
- **Print-out / dive slate** — export the plan (turn pressures, gas, drops, distances) to a
  compact, **label-printer-friendly** format you can stick to a wrist slate or wet notes (some
  gas analyzers already print labels). The plan is ephemeral, so this is a one-shot artifact,
  not saved state.

---

## 10. Decisions & open questions

**Resolved (Nico, 2026-06-21):**
1. **#77 / jumps & references:** calculate jump distances; reference shots resolve and the
   **shortest path is chosen** — no edge exclusion, not a blocker (§6).
2. **Reserve / staging:** three presets + return-leg recalc, specified in **§5.1**; All-thirds
   is the default, the pushy 1-/2-stage presets are advanced-gated.
3. **DPV gas effect:** **no reduced RMV** on the scooter — same RMV as swimming. Hard
   scootering can demand as much gas as swimming; the unreduced RMV is a deliberate soft
   safety margin. DPV affects **speed + range/burn-time** only.

**Still open:**
4. **Memoization:** confirm "debounce-only" holds on the largest real survey, or add the
   single-slot `AppState` memo (§7.1).
5. **Turn-gloss (§5.1):** confirm "turn at 1/N" = consumed (minor). *(Recalc regions/formulas,
   direction, and pressure-semantics now resolved.)*
6. **In-flight planning Q&A (still to answer):** **CCR bailout** specifics (dedicated bottles
   vs stages-as-bailout; stressed-multiplier value; diluent/O2 negligible?); is a **"lead"**
   any selected station or a first-class marker? *(Survey-RMV task-loading resolved → opt-in
   slider, §5.2.)*

---

## 11. Verification
- **Rust (gated `--features telemetry`):** golden-fixture unit tests in `core/gas/tests.rs` —
  hand-computed `ata`/`gas_rate`/`edge_gas`; a 3–4 station survey with known depths where the
  thirds round-trip budget is hand-computed, asserting `reachable[]`, `turn_frontier`,
  `gas_to_reach[lead]` to tolerance. **Adversarial:** empty/no-zero-datum project (→ all
  unreachable, like `compute_penetration_distances`, `project.rs:7514`), disconnected lead,
  merge/closure on the path (0-cost), a **jump shortcut (its distance counts)**, a **reference
  shot that resolves to the shortest path** (§6), near-zero/above-surface depth (`ata` clamps).
- **Frontend:** vitest for store + unit conversions; Playwright `@smoke` for enter/exit +
  reachable-overlay render-and-reset against mocked IPC (mirror the distance-gradient e2e).
- **Manual/e2e:** load a real `e2e/fixtures/*.dmp`, enter the mode, check the reachable
  frontier + turn point against a hand calc.

## 12. Critical seams (file:line)
> ⚠ Lines pinned to `master` @ 2026-06-22 (**pre-refactor**). A Rust refactor is in flight on
> the other clone — **re-verify every seam before implementing** (especially the graph/Dijkstra
> code, which both the refactor and our weight-closure change touch).

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
