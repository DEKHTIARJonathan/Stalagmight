# PRD: Gas & Route Planning Mode (Stalagmight #38)

> **Status:** Draft for review · **Issue:** [#38](https://github.com/Stalagmight/Stalagmight/issues/38)
> (`enhancement`/`P3`/`planning`) · **Owner:** Nico · **Deco:** out of scope (separate future issue)
>
> **This is a living artifact.** Hand-edit freely — strike what's wrong, add cave-diver
> reality I've missed, re-rank the phases — and hand it back; I'll reconcile against the
> code and keep the file:line seams honest. The phased plan at the bottom is the part that
> becomes PRs.
>
> **▶ Hold lifted (2026-06-24).** The Rust refactor (#157, PRs through #175) **landed** —
> `project.rs` was split into `models/project/{pathfinding,distance,coordinates,closure,lsq,…}`,
> and the #160/#167 GUI rework reshaped the frontend. The §4/§7/§11/§12 seams were
> **re-verified and repinned** against the new layout (the 2026-06-24 re-assessment pass), and
> four architecture/UX forks were resolved (engine home, exit-field, UI entry, right panel —
> §7/§10). **Implementation can begin — local commits only until Nico approves a push** (§8).

---

## 1. Context & the reframe

Issue #38 is a deliberate stub: *"A planning mode for efficient dive plans: gas map and
deco from an arbitrary entrance to a lead. Large scope — needs its own spec/PRD."* This is
that PRD.

**The reframe that drives everything (Nico):** this is **not** "given a route, compute the
gas." It is **route-finding under a gas / bailout constraint** over the cave survey graph.
The headline interaction is the *inverse* problem — *"given my gas, how far can I get, and
where do I turn?"* — drawn on the actual surveyed line.

It serves **two missions on one engine**: **exploration** (push toward a *lead* — virgin cave
beyond the line) and **resurvey** (re-cover *known* passage, where there are **no leads** —
e.g. *Naharon*). The gas math is identical; only the objective differs (reach a lead vs cover
an area), so the planner **never assumes a lead exists**.

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
| UX | **Right panel** (inputs + readout) + central map (frontier / turn / drops); **frontier-first** flow; **gradient + hard turn-line**, push-headroom faint/opt-in (§7.3) |

---

## 4. The core engine — gas-weighted shortest path

The domain layer is **already factored for this** — we extend, not rebuild:

- `Project::build_survey_graph(n, station_index, coords)` (`models/project/pathfinding.rs:567`,
  **`pub(super)`** — module-private to `models::project`) → adjacency `Vec<Vec<(usize,f64)>>`.
  Edges = all shots (incl. jump/reference) + zero-cost station merges + zero-cost loop closures.
- `Project::dijkstra(adj, roots)` (`pathfinding.rs:630`, **`pub(super)`**) — generic over **any
  non-negative edge weights**, multi-source, `∞` for unreachable, returns `Vec<f64>` (distances
  only, **no predecessors** — `distance.rs:321` has the pred-tracking variant to copy). Gas costs
  are non-negative ⇒ reused verbatim.
- `compute_distances_from` (`distance.rs:22`; its doc comment at `distance.rs:20` literally names
  *"a future gas-planning mode"* as a target consumer) + `distance_field_from` →
  `DistanceField {distances, station_refs, max_reachable}` (`distance.rs:71`; struct at the module
  root `project.rs:358`) are the **sibling-submodule pattern to copy** — both reach the `pub(super)`
  graph fns via `self.build_survey_graph(…)` / `Self::dijkstra(…)` (the basis for the §7.1 engine
  home).

**Gas edge cost** = `gas_rate(avg_depth) × (edge_length / speed)`, where
`gas_rate(z) = RMV × ATA(z)`, `ATA(z) = 1 + max(z,0)/10` (10 msw ≈ 1 bar),
`z = Coordinates.z` (meters, **positive-down**, `station.rs:223`, set via `compute_station_depth()`
`coordinates.rs:70`, written at `coordinates.rs:130`).
`avg_depth = ½(z_from + z_to)` — trapezoidal mean over a straight leg, cheaply available
from the measured station list (no extra survey walk; ⚠ a leg that **crosses the surface** — air
bell / sump — slightly under-counts because `ata` clamps the *average*, not the integral;
negligible for cave penetration, but note it). Merges/closures stay 0-cost (same physical point ⇒
0 gas — correct).

**Why it's cheap & correct:** reachability/distance is **coordinate-independent** (closure
adjustment only nudges coords sub-meter), so the gas engine consumes the **instant** measured
coords (`compute_station_coordinates()`, `models/project/coordinates.rs:266`) and **never**
triggers the slow ~2 s/~40 s closure solve (`compute_adjusted_station_coordinates`,
`coordinates.rs:354` — the one the gas command must NOT call). This mirrors the existing
`AppState::distance_field` decision (`core/state/app_state.rs:364`), which already rejects the
adjusted solve for the same reason.

**Everything derives from ONE Dijkstra (the in-field) + its predecessor tree:**
- *Reachable within budget* = stations whose **round-trip** gas ≤ usable gas after the §5.1
  reserve rule. **Round-trip is asymmetric** when surveying: `gas_in(X | survey speed) +
  gas_out(X | swim speed)`. **⚠ Correction (2026-06-24): `gas_out(X)` is the gas integral along
  the REVERSE of the entry path — re-weighted at exit RMV/swim speed — NOT an independent
  shortest-path-to-exits Dijkstra.** A free exits-seeded field could route the exit through a
  shorter *unswum* connection the graph offers, which (a) violates §6 "exit the way you came" and
  (b) **under-budgets the return → over-states reach — the dangerous direction.** So: run ONE
  Dijkstra (the in-field), track its **predecessor tree**, and for any X walk `pred[]` from X back
  to the root accumulating exit-weighted edges. (Edge geometry — `length`, `avg_depth` — is
  symmetric under reversal; only the RMV/speed weight differs, and survey→exit is a positive
  rescale, so the in-field's chosen path IS the correct exit path.) The turn frontier is a
  threshold on the field (reachable stations with an unreachable neighbor — one pass over `adj`).
- *Turn point toward a lead* = furthest point on the entry path where one-way gas = turn pressure;
  read straight off the predecessor walk above. Use the existing **predecessor-tracking
  shortest-path helper** (`distance.rs:321`) as the template — do **not** bolt predecessors onto
  the shared `pub(super)` `dijkstra`, which returns distances only.
- *CCR bailout / dead-scooter exit* = the **same reverse-entry-path integral** at stressed RMV /
  swim speed (you bail off the scooter and swim out the way you came). The bailout "integral" is
  just the predecessor-walk's accumulated exit-weight — **one** field, no separate exits-seeded
  Dijkstra.

---

## 5. Domain model (the gas math)

Canonical **SI internally** (liters, bar, meters, L/min); convert only at the IPC/format
boundary (mirrors how the codebase stores meters and converts in `formatStats.ts`).

```
Diver { rmv_l_per_min: f64, label: Option<String> }
  // RMV is canonical. SAC is a CONSTRUCTOR concern, never stored:
  // Diver::from_sac(sac_bar_per_min, ref_cyl) => rmv = sac * ref_cyl.water_volume_l.
Cylinder { water_volume_l, rated_pressure_bar, fill_bar, material: TankMaterial, role: CylRole }
  // fill_bar is an INPUT and may EXCEED rated — overfilling is routine (LP85s @ 210–230 bar,
  // §5.3); rated is reference only, NEVER a clamp. material (Alu|Steel) hints stage-vs-backgas.
  // role: BackGas | Stage | DilOut | Bailout. DilOut reserves a user-set dil_suit_reserve_bar
  // (diluent + suit inflation), rest = bailout (§5.5).
GasConfig {
  reserve: ReservePreset,        // AllThirds | OneStage | TwoStage — see §5.1; pushy presets gated to "advanced"
  stressed_rmv_multiplier: f64,  // user-settable; DEFAULT 1.5×; bailout/contingency bump (§5.5)
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

**✅ Calibration resolved (Nico, 2026-06-24):** "back gas" is a **matching twin set** — manifolded
twins *or* unmanifolded doubles / sidemount (the two cylinders match and are worn hard-to-doff;
assume kept on the diver throughout, bar tiny restrictions) — and is **planned as ONE volume**. So
`current_backgas` is the **common per-cylinder gauge pressure** (both equal), and the engine restates
the bar constants in volume as `reserve_volume(region) = held_pressure(region) × Σ(twin water_volumes)`.
`100/70/−15` live in a **named, editable `ReserveProfile`** (not literals baked in).

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

**✅ Resolved (Nico, 2026-06-24): "turn at 1/N" = turn when 1/N of usable is *consumed*.** For
All-thirds (N=3): consume ⅓ on the way in, **turn**, hold **⅔** for the exit (planned swim-out +
emergency reserve). **OC only — CCR uses the dil-out/bailout model (§5.5), not this fractional
rule.** Because survey-in is far costlier per metre than the fast swim-out (§5.2), the held ⅔ is
*more* than the computed `gas_out` actually needs — that surplus is exactly the opt-in
push-headroom (§5.2/§6).

### 5.2 Surveying changes the gas math — asymmetric speed + a less-opinionated reserve (Nico)

**Total-thirds is the invariant, not per-tank thirds.** The safety floor is **⅓ of *total*
gas reserved across all cylinders**. Gas can be **moved between cylinders** (Nico dives 2
back-gas + 2 stages) — you may run plain ⅓-per-tank, or balance gas across tanks; the balanced
scheme still preserves total thirds. The §5.1 presets are these thirds-preserving
distributions; the engine's hard floor is **total-thirds**, presets only change *where* gas is
spent. *(Audit note: that quarters-backgas / sixths-backgas + the stage turns net to total-thirds
isn't self-evident — show the arithmetic and assert it in a unit test.)*

**Survey-in is 2–3× slower than the swim-out.** Surveying is slow work; the exit is a fast
swim (default **10 m/min**, no DPV). So per-meter gas IN ≫ OUT, and **round-trip gas is NOT
2× one-way**: `round_trip(X) = gas_in(X | survey speed) + gas_out(X | swim speed)`, where
`gas_out` is the **reverse-of-entry-path** integral at swim speed (§4 — one Dijkstra + its
predecessor tree, *not* an independent exits-seeded field; that same reverse path is what CCR
bailout integrates over).
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

**Back gas = one planning volume (Nico).** "Back gas" means a **matching twin set** — manifolded
twins *or* unmanifolded doubles / **sidemount** (sidemount is just unmanifolded twins). By
convention the two cylinders are identical and worn hard-to-remove, and stay on the diver except at
very tight restrictions — so for planning they're **one combined volume** at a **common gauge
pressure** (`volume = pressure × Σ water_volume`), never two independent budgets. ⏳ **Tank-capacity
table incoming** (Nico will supply) → populate the presets below from it.

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
  **breadth-first** (cover many branches — exploring leads *or* resurveying known passage)
  drive different placements.

⇒ The tool **shows the feasible range and validates the choice; it never prescribes the spot**
(another §6 "aid, not authority"). The depth-first/breadth-first axis is the same one the
fan-out optimizer reasons on later (§9).

### 5.5 CCR bailout — the "dil-out" model (Nico)

Rebreather-specific, but in these caves the units are **sidemount CCRs (Sidewinder / Gemini —
identical for this purpose)**, which collapses to one pattern:
- One sidemount cylinder is the **diluent**, run as **"dil-out"**: only a small amount is spent
  on **diluent + drysuit inflation** over the dive (~15–20 bar typical), and **the rest is
  bailout**. The diver **specifies that reserve** (`dil_suit_reserve_bar`, default ~20) → its
  **bailout volume = (fill − dil_suit_reserve) × water_volume**.
- That **dil + suit reserve is user-set** and not distance-dependent; O₂ is metabolic,
  negligible for *bailout-gas* planning. So CCR penetration isn't gas-limited — **the constraint
  is bailout volume to exit** (the §5.2 exit field at stressed RMV / swim speed).
- **Extra bailout bottles extend range:** some carry additional cylinders purely as bailout to
  push further.

**Model:** give each `Cylinder` a **role** (back gas / stage / **dil-out** / bailout). Available
bailout = Σ usable over bailout-capable cylinders (dil-out gives `fill − dil_suit_reserve`;
dedicated bailout bottles give full usable). **Constraint:** available bailout ≥ the exit integral from the **single worst point** (the
max-exit-gas point; on a monotone line that's the furthest penetration / the lead — branching caves
take the max over branch tips), checked along the route; where short, **stage bailout** (drop bottles
— §5.4 mechanics, bailout variant). Stressed-RMV multiplier applies — **user-settable, default 1.5×** (Nico, 2026-06-24). *(Sidemount dil-out is the common case; the role model also covers
back-mount CCR — a non-bailout Diluent role + dedicated Bailout bottles.)*

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
  the graph offers but the diver didn't swim — **enforced in §4** by integrating `gas_out`/bailout
  along the in-field's **predecessor tree** (the route actually swum), not a free Dijkstra to
  exits. (Also why **traverses are out of scope**, §2.)
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

### 7.1 Backend (Rust) — a new `models/project/gas/` submodule (NOT `core/gas/`)
**Decision (2026-06-24, Nico):** the engine lives as a **sibling submodule of the topology code**
— `src-tauri/src/models/project/gas.rs` (or a `gas/` dir), declared `mod gas;` in `project.rs`'s
child-`mod` block (`:20-40`). The #157 refactor moved all topology compute *into* `models/project/`
and made `build_survey_graph`/`dijkstra`/`zero_datum_roots` **`pub(super)`** — so a `core/gas/`
module **could not call them** without re-widening the encapsulation the refactor just added. As a
sibling it reaches them via `self.build_survey_graph(…)` / `Self::dijkstra(…)`, **exactly as
`distance.rs` already does** — zero visibility changes. Only the thin IPC layer stays outside, in
`commands/gas.rs`. Files (inside `models/project/gas/`): `mod.rs` (the `impl Project` driver —
`plan_gas_reach` / `plan_to_lead` returning the IPC structs), `physics.rs` (pure
`ata`/`gas_rate`/`edge_gas`, no graph — golden-tested), `model.rs` (TS-deriving model + IPC
structs), `tests.rs`. *(Supersedes the earlier `core/gas/` plan — structurally impossible
post-refactor: `core/mod.rs` holds loading/state/IO, not topology compute.)*

- **Factor the weight out of `build_survey_graph`.** The weight choice is one `match coords` at
  `pathfinding.rs:585` (`Some` ⇒ straight-line between coords; `None` ⇒ `shot.length`).
  Generalize to a closure — `build_survey_graph_weighted<F>(…, weight: F)` (stays `pub(super)`) —
  and make `build_survey_graph` a thin wrapper, so the **four existing callers**
  (`compute_distances_from`, `compute_penetration_distances`, `distance_field_from`, and
  `along_line_between`, all in `distance.rs`) are behavior-preserving. ⚠ **Preserve the
  section/shot iteration order** — `along_line_between` (`distance.rs:239-254`) builds a parallel
  shot-edge map keyed on that exact edge-emission order; reordering breaks it. The gas engine
  passes a closure capturing `(rmv, speed, &coords)` computing per-edge gas; merges/closures stay
  0-cost (`pathfinding.rs:597-621`).
- **`GasReachField`** (mirror `DistanceField`, JSON-safe `Option` for `∞`):
  `{ station_refs, gas_to_reach: Vec<Option<f64>>, reachable: Vec<bool>,
  turn_frontier: Vec<StationRef>, max_reachable_gas, budget_litres }`.
- **Caching: don't (yet).** A measured-coords gas Dijkstra is O(E log V) — milliseconds even
  at 6k stations; the expensive thing is the closure solve, which we never call. Ship Phase 1
  with a **frontend debounce** (150–250 ms) on the param sliders. Add a single-slot
  `AppState` memo (key = `modified_at` + **origin** + **gas-params hash**) only if a large
  survey stutters — note the key needs the params hash, unlike distance.
- **IPC** (`commands/gas.rs`, modeled on `get_station_distances_from`, `commands/project.rs:129`;
  `spawn_blocking`, one reconciled snapshot): `compute_gas_reach_field(origin?, gas_config,
  team, mode)` and `compute_gas_plan_to_lead(origin?, lead, …)`. Delegate to `AppState`
  (`core/state/app_state.rs`) methods that call `compute_station_coordinates()`
  (`coordinates.rs:266`, measured) — **never** `compute_adjusted_station_coordinates()`
  (`coordinates.rs:354`). Register in `tauri::generate_handler!` (`lib.rs:1225`).
- **ts-rs**: all IPC structs `#[derive(TS)]`. Regen is now a **cargo example** — `pnpm gen:ipc-types`
  runs `cargo run --example gen_ipc_types --features ipc-typegen` — and a new struct needs explicit
  **import + export wiring** in that example, not just the derive. Never hand-edit `src/types/ipc/`.
- **Telemetry** (append-only/frozen registry): the two **read-only query** commands auto-emit via the
  `invokeIpc` wrapper — just add `command.compute_gas_reach_field` / `command.compute_gas_plan_to_lead`
  to `telemetry/registry.rs` **and bump the exact `EVENT_NAMES.len()` count** (read-only ⇒ NOT in
  `UNDOABLE_COMMANDS`). `registry_covers_all_commands` (`registry.rs:583`) is CI-gated under
  `--features telemetry` and fails if missing.
- **Lints/format are CI gates:** no `unwrap/expect/panic` in prod gas code; per-test-module
  `#[expect]` for the math tests; `cargo fmt` + clippy before pushing (`docs/linting.md`).

### 7.2 Frontend (TS/React) — a single-view sub-mode, NOT a new top-level view
A third `ViewType` (`uiStore.ts:27`, branch at `App.tsx:475`) would **re-mount its own map**,
losing survey layers/camera/GPS origin. Gas planning wants the *same* `MapCanvas` + overlays + a
panel. **The distance-gradient infra it mirrors all still exists post-#160 (lines moved ~80–90
each); the mirror strategy survives** — three structural changes folded in below.

- **Entry = a top-level toggle, OUTSIDE `DisplayMenu` (Nico's call).** Post-#160 the color overlays
  (section/depth/distance/issues) are a **single mutually-exclusive `ColorMode`** (`uiStore.ts:52`,
  single owner `setColorMode()` `:1155`, radio pills `DisplayMenu.tsx:222`). Gas-plan is a full
  interaction *mode*, not a paint style, so it does **not** join that radio family. Add a
  `gasPlanActive` flag entered via a **toolbar/Display toggle + Esc**; while active it **forces a
  gas-specific paint and suppresses the `ColorMode` overlays — suppression is now structural via
  `setColorMode`**, not the parallel flag-toggle the pre-rework draft assumed.
- **Teardown:** add `exitGasPlan()` to the `setView()` cleanup funnel (`uiStore.ts:581`, beside
  `exitSectionFocus()` `:585` / `exitDataTableFullScreen()` `:587`) so a stale gas overlay can't
  outlive a project switch or return-to-global. ⚠ The distance-gradient precedent does NOT reset via
  `setView` — it uses a `MapCanvas` effect keyed on `project?.created_at` (~`:1877`); a `setView`
  teardown is the stronger choice for a heavier mode, but confirm (§10 open).
- **`src/store/gasPlanStore.ts`** (new, mirrors `globalViewStore.ts`): `gasConfig` (seeded from
  `Config.gas`), `team`, `mode`, `entranceStation`, `selectedLead`, `reachField`, `leadPlan`,
  `userDrops` (Phase 2). Setters **null the result on input change** (mirror
  `setDistanceGradientOrigin` clearing `distanceField`, `uiStore.ts:378-389`/`:1104`) so stale
  colors never show under a new legend. `reset()` from `exitGasPlan()`. ⚠ **The seed point is the
  penetration ENTRANCE STATION, not the GPS `gpsOrigin`** (`MapCanvas.tsx:284`) used for the ENU map
  transform — don't conflate them; reachability is GPS-origin-independent.
- **IPC effects** (model on the distance fetch, `MapCanvas.tsx:1828`, use `invokeIpc` not raw
  `invoke`): `let cancelled` guard (`:1830`); **debounce** the `gasConfig` dep; deps include
  `project?.modified_at`; **also** capture a project-identity signal at request time and drop stale
  replies on project switch. ⚠ `projectIdentityKey` (`useMapTools.ts`) is **private / not exported**
  — export it, or reuse `project?.created_at` (the switch detector the distance overlay already uses).
- **Map overlays** (overlay region `MapCanvas.tsx:3385`, runtime-only, reset on switch):
  reachable-extent feature-state (`utils/gasReach.ts`, sibling of `utils/distanceGradient.ts`,
  whose `buildDistanceFeatureState` is at `:41`); turn-point marker (MapLibre `Marker`, cf. origin
  marker `:1877`); selected-lead path tint (reuse `setMeasuredPath`, `MapCanvas.tsx:1866`); drop
  markers (Phase 2 — ⚠ **draggable markers are NEW**: every existing `Marker` is non-draggable and
  there's no drag-along-line/snap machinery to reuse — see §5.4/§7.3). A `GasLegend.tsx` mirrors
  `DistanceLegend.tsx`.
- **Input panel + readout:** see §7.3 — it **reuses the right `Dock` slot** (swaps `DetailPanel`
  content in gas mode). Fields: diver/RMV/SAC, cylinders + roles, reserve preset, swim/DPV/survey
  speeds, OC/CCR toggle; readout of budget, max penetration, per-cylinder turn pressure, and (lead
  selected) gas-to-reach + within-budget. The **map-click station pick** to set the entrance lives
  in `useMapTools.ts` (surfaced via `DetailPanel`), **not** `MapCanvas` as the earlier draft implied.
- **Gas units**: new `Config.gas` block (`config/types.rs:9`, `#[serde(default)]` like the other
  newer blocks — **bundle gas units in `GasConfig`, don't bloat `UnitsConfig`** at `:828`); seed the
  TS default at `src/types/config.ts` alongside `units:`; add `src/utils/formatGas.ts`
  (`formatPressure`/`formatVolume`/`formatRmv`, metric first, conversion seam so imperial is a
  Phase-4 flip — never hardcode suffixes; cf. `formatStats.ts:54` `formatLength` / `:29`
  `getUnitSuffix`); extend `settings/UnitsSettings.tsx` with a gas sub-section. **✅ One MASTER unit toggle
  (Nico):** a single metric/imperial selector drives length/depth (`UnitsConfig`) **and** gas
  pressure/volume together — no independent gas toggle; `GasConfig.units` (if kept) derives from the
  master selector, never set separately.

### 7.3 UX — layout & interaction (Nico, 2026-06-23)

Concretises the choices §7.2 left open:
- **Layout: REUSE the right `Dock` slot (Nico's call).** Post-#160 the right edge is a single
  `Dock` (`SingleSystemView.tsx:586`, `edge="right"`) owned by `DetailPanel`; `PanelId` is a closed
  union `'sections'|'detail'|'data-table'` (`uiStore.ts:74`). So gas-plan **swaps the `detail`
  slot's content while gas mode is active** (Details hidden meanwhile) rather than adding a 4th
  panel — holding inputs (diver/RMV, cylinders + roles, reserve preset, speeds, OC/CCR, team) **and**
  readout (turn pressure per cylinder, penetration, bailout). The **map stays central** — frontier
  shading, turn-point ●, drop markers ▽. Enter/exit via a **toolbar/Display toggle (outside the
  `ColorMode` menu) + Esc**; reset through the `setView()` funnel.
- **Flow: frontier-first.** On entry the diver's rig/RMV/reserve paint the **reachable frontier
  immediately**; **clicking any station drills into** its turn / gas / bailout readout. No
  target is required (§1 resurvey case) — selecting one just deepens the readout.
- **Frontier viz: gradient + a hard turn-line.** Shade stations/shots by **gas-to-reach** (reuse
  the distance-gradient feature-state infra → `utils/gasReach.ts`) **plus a distinct hard
  turn-point boundary**. **Push-headroom** (§5.2) renders only as a **faint, opt-in extension**
  beyond the thirds line — thirds is the visual primary (§6 automation-bias). `GasLegend`
  mirrors `DistanceLegend`.
- **Drop placement: suggest + drag-validate.** The tool drops a suggested marker inside the
  gas-feasible envelope (§5.4); the diver **drags it along the line**, live-colored green
  (works) / red (outside the envelope), **snapping to stations**. The judgment is the diver's,
  the guardrail the tool's. ⚠ **This is NEW interaction — no precedent:** every existing MapLibre
  `Marker` is non-draggable and there's no drag-along-line / project-onto-nearest-segment /
  snap-to-station machinery to reuse. Scope it in **Phase 2** (draggable `Marker` + project the
  dragged lng/lat onto the nearest shot polyline + snap within a threshold + re-validate against the
  reach field on drag); a station-list / click-to-place picker is the simpler v1 fallback.
- **Rig setup: saved rig profiles (Phase 1 — Nico).** Pick a saved rig ("my standard rig" — e.g.
  2× LP85 back gas + 2× AL80 stages) from **user config** (a `Vec<RigProfile>` in global `Config`,
  edited via Settings), then tweak fills per dive. Built on the §5.3 tank presets; profiles are
  personal defaults (user config, never the `.stalx`). **In Phase-1 scope**, not deferred.
- **Push-headroom: explicit opt-in toggle, OFF by default.** A "Show push-headroom" control,
  default **off**, so the conservative thirds view is the resting state; when on, the faint
  labeled extension (above) appears. Strongest §6 automation-bias posture.
- **OC/CCR: a mode toggle at the panel top.** One switch swaps the relevant fields — OC → stages
  + back-gas thirds; CCR → dil-out reserve + bailout (§5.5). One rig, two lenses.
- **Team: single-diver in v1; team is Phase 5** (§8). When it lands: a roster with the limiting
  (lowest usable-volume, §5.3) diver **badged** so you see who gates the dive. v1 keeps the panel
  simple.
- **Readout leads with penetration distance / time** (the planning headline); per-cylinder turn
  pressures + bailout margin are the supporting detail (the numbers you'd copy to a slate).

---

## 8. Phasing (epic → shippable slices)

> Interpreting "both in MVP": **both OC and CCR are the destination**, but they are *not* one
> PR. They share the engine, yet they couple three independent risk surfaces (gas-Dijkstra
> correctness; exit-integral + drop validation; team reduction). Phase 1 ships the slice that
> *forces the engine to exist correctly* and is independently useful; the data model is built
> CCR/team-shaped from day one so later phases add no migrations. Re-rank these freely.

- **Phase 0 — Foundations (no UI):** `Config.gas` + gas units + `formatGas.ts`; the gas
  domain model + SAC→RMV; `models/project/gas/{physics,model}.rs` with golden unit tests. Small, safe,
  fully testable in isolation.
- **Phase 1 — OC reachable-frontier (headline):** the `build_survey_graph_weighted` refactor;
  `GasReachField` + `compute_gas_reach_field`; sub-mode shell (enter/exit + `setView` reset),
  single-diver input panel, reachable-extent overlay + turn point + readout; `gasPlanStore`;
  **saved rig profiles** (`Vec<RigProfile>` in `Config`). Single diver, both unit systems.
  **First user-visible vertical slice.**
- **Phase 2 — Lead→plan + OC stages + drops:** `compute_gas_plan_to_lead` (back-traced path),
  stage gas, turn pressures, suggested + draggable-validated drops, drop markers.
- **Phase 3 — CCR bailout (dil-out model, §5.5):** `PlanMode::CcrBailout`, bailout volume
  (exit-from-lead, stressed RMV, swim speed) ≤ available bailout (dil-out remainder + extra
  bottles), bailout staging + drops. Reuses 100% of the engine.
- **Phase 4 — DPV range/burn-time + dead-scooter contingency; imperial units flip.**
- **Phase 5 — Team:** matched gas (dissimilar-tank matching = **lowest usable-volume diver
  gates**; common in Florida — §5.3), weakest-link reserve, CCR team bailout sharing (a `fold`
  over per-diver fields — no new graph math).
- **No #77 dependency:** #77 is resolved as *no edge filter* (§6/§10) — the graph keeps all
  jump/reference edges and trusts shortest-path, so there is nothing to schedule here.
  *(Removed a stale "schedule the #77 edge filter early" bullet that contradicted §6/§10.)*
- **Each phase = its own local branch off `master`**, small semantic commits, tests included.
  **Local commits only — do NOT push or open a PR until Nico approves** (current directive). Run
  `/pre-pr` locally before any eventual push (it's a local gate, not CI). Don't self-merge.

---

## 9. Future directions (where this could go)

- **Diver fan-out for exploration / resurvey (the north star).** Given per-diver
  `GasReachField`s, recommend an **allocation of teams to leads** maximizing an objective —
  *new* passage reached (exploration) or *re-covered* passage (resurvey) — subject to each
  diver's gas/bailout budget and shared-staging logistics. It's a coverage/assignment problem
  on top of the reachability fields (think: weighted set-cover / orienteering over the graph).
  The engine primitive (the field) and the team-shaped model make this additive, not a
  rewrite.
- **First-class leads** — let the surveyor **mark leads** (at a station or mid-shot; line
  already there, or virgin needing line run) as durable points for planning future exploration
  / surveying. These become natural **targets** for the planner *and* the fan-out optimizer
  above. **But leads are exploration-specific — not always present:** a **resurvey** of old,
  well-explored cave (e.g. *Naharon*) has none. So the planner **never requires a lead** — the
  target is any selected station/area (MVP); lead-marking is a future convenience for
  exploration, not a precondition.
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
4. **Architecture forks (2026-06-24):** engine = `models/project/gas/` sibling (§7.1); exit/bailout
   = **reverse-of-entry-path**, not an exits-Dijkstra (§4/§6); UI entry = top-level toggle **outside**
   `DisplayMenu` (§7.2); right panel = **reuse the `detail` `Dock` slot** (§7.3).

**Still open:**
4. **Memoization:** confirm "debounce-only" holds on the largest real survey, or add the
   single-slot `AppState` memo (§7.1).
5. **Turn-gloss (§5.1) — NOT minor:** confirm "turn at 1/N" = *consumed* vs *reserved*; it flips
   the sign of the §5.1 recalc formulas (2026-06-24 audit).
6. **Stressed-RMV value:** confirm `stressed_rmv_multiplier` (placeholder 1.5–2.0) — it scales every
   CCR bailout number. *(Planning batch otherwise resolved: traverses out; ≤2 stages; drop envelope;
   ephemeral plan + print-out; survey-RMV slider; CCR dil-out; lead = future marker §9, MVP targets a
   selected station.)*
7. **Recalc calibration (§5.1):** what back-gas rig are `100/70/15` bar calibrated to (single /
   manifolded twins / independent doubles), and is `current_backgas` a per-cylinder gauge or a total?
8. **Gas-mode teardown (§7.2):** `setView()` `exitGasPlan()` (stronger) vs a `created_at` `MapCanvas`
   effect (matches the distance-overlay precedent)?
9. **Two unit toggles (§7.2):** length/depth follow `UnitsConfig.length`, gas follows
   `GasConfig.units` — reconcile the readout (one toggle for both, or independent + clear labels)?
10. **Saved rig profiles (§7.3):** in Phase 1 scope, or later? And where does the list live (a
    `Vec<RigProfile>` in global `Config`, edited via Settings)?

---

## 11. Verification
- **Rust (gated `--features telemetry`):** golden-fixture unit tests in `models/project/gas/tests.rs` —
  hand-computed `ata`/`gas_rate`/`edge_gas`; a 3–4 station survey with known depths where the
  thirds round-trip budget is hand-computed, asserting `reachable[]`, `turn_frontier`,
  `gas_to_reach[lead]` to tolerance. **Adversarial:** empty/no-zero-datum project (→ all
  unreachable, like `compute_penetration_distances`, `models/project/distance.rs:42`), disconnected lead,
  merge/closure on the path (0-cost), a **jump shortcut (its distance counts)**, a **reference
  shot that resolves to the shortest path** (§6), near-zero/above-surface depth (`ata` clamps).
- **Property/invariant tests (safety, §6):** beyond golden cases, assert on random small surveys —
  gas *requirements* round up & reachable extent rounds down; `round_trip(X) ≥ gas_in(X)`; the
  reverse-path `gas_out(X)` is **never less** than a free Dijkstra-to-exits would give (the safety
  direction); reachability invariant to swapping measured↔adjusted coords. (Repo has a fuzz/property
  precedent.)
- **Frontend:** vitest for store + unit conversions; Playwright `@smoke` for enter/exit +
  reachable-overlay render-and-reset against mocked IPC (mirror the distance-gradient e2e).
- **Manual/e2e:** load a real `e2e/fixtures/*.dmp`, enter the mode, check the reachable
  frontier + turn point against a hand calc.

## 12. Critical seams (file:line)
> ✅ Repinned to `master` @ 2026-06-24 (**post-refactor #157 + post-#160/#167 GUI rework**).
> `project.rs` is now the ~1178-line module ROOT; the graph/Dijkstra/coords logic lives in
> `models/project/{pathfinding,distance,coordinates}.rs`, and AppState is at
> `core/state/app_state.rs`. Verified by the 2026-06-24 re-assessment — re-check once more at
> implementation time, as line numbers drift.

- `src-tauri/src/models/project/pathfinding.rs` — `build_survey_graph:567`, `dijkstra:630`,
  `zero_datum_roots:676` (all **`pub(super)`**; the weight choice = the `match coords` at `:585`).
- `src-tauri/src/models/project/distance.rs` — `compute_distances_from:22`,
  `compute_penetration_distances:42`, `distance_field_from:71` (the sibling-call template);
  **predecessor-tracking** shortest-path helper at `:321` (copy this for back-tracing, not the
  shared `dijkstra`).
- `src-tauri/src/models/project/coordinates.rs` — `compute_station_coordinates:266` (measured;
  what the gas command calls), `compute_adjusted_station_coordinates:354` (**must NOT call**),
  `compute_station_depth:70` → sets `coords.z` at `:130`.
- `src-tauri/src/models/project.rs` (module root) — `DistanceField` struct `:358`; declares the
  child `mod`s at `:20-40` (**add `mod gas;` here** — §7.1).
- `src-tauri/src/core/state/app_state.rs` — `distance_field:364` (measured-coords precedent),
  `adjusted_cache` field `:114` / `AdjustedStationsCache` struct `:49` (mirror-or-skip).
- `src-tauri/src/commands/project.rs:129` — `get_station_distances_from` (the IPC command template).
- `src-tauri/src/config/types.rs:9` — `Config` (add `gas`); `:828` `UnitsConfig` (leave alone).
- `src-tauri/src/models/station.rs:223` — `Coordinates` (`.z` depth, +down); `:364` `ZeroDatum`.
- `src/components/Map/MapCanvas.tsx` (3567 LOC) — distance fetch `:1828`, feature-state `:1843`
  (`buildDistanceFeatureState`, `utils/distanceGradient.ts:41`), origin marker `:1877`,
  `setMeasuredPath` `:1866`, overlay region `:3385` (the overlay template); `gpsOrigin` derive `:284`.
- `src/store/uiStore.ts` (1507 LOC) — `ViewType:27`, `setView` cleanup `:581`, `ColorMode:52` +
  `setColorMode:1155` (the overlay paint owner), distance-gradient state `:378-389`/impl `:1104`,
  `PanelId:74` (closed 3-union). `App.tsx` view branch `:475`.
- `src/components/SingleSystemView/SingleSystemView.tsx:586` — the right `Dock` (`edge="right"`,
  `DetailPanel`); `DisplayMenu.tsx:222` (ColorMode pills); `useMapTools.ts` (private
  `projectIdentityKey` + the map-click station pick).
- `src/utils/formatStats.ts:54` — `formatLength` / `:29` `getUnitSuffix` (template for `formatGas.ts`).
