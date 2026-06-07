# Distance Gradient from a Chosen Point — #34

> **Status:** PLANNING · **Issue:** #34 (`enhancement`, `P3`, `map`, `viz`, milestone `demo2`)
> **Branch:** `feat/map-distance-gradient` · **Owner:** Nico · **Last updated:** 2026-06-06
>
> Living design doc. Architecture is **decided**; UX choices are **proposed** and
> flagged where Daniel's sign-off is wanted. Keep this updated as decisions land.

---

## Progress
- [x] **Backend seam refactor** — `build_survey_graph` + `dijkstra` +
  `compute_distances_from(roots)`; `compute_penetration_distances` now a caller.
  Tests pass, no behavior change. (`7e938f88`)
- [x] **Jump-vs-reference reachability heuristic** in `build_survey_graph` — keep
  an `is_reference` shot only when it bridges otherwise-disconnected components
  (a jump); drop redundant ones (double-count). Shared graph, so
  penetration/export use the corrected reachability. Temporary → retire under
  **#77**. Tests green (1511+80). (`626b2f95`)
- [x] **IPC** — `DistanceField` + `Project::distance_field_from(Option<&StationRef>)`
  (None = entrance default) + `get_station_distances_from` command + ts-rs +
  telemetry event (Rust+worker). cargo(+telemetry) & tsc green. (`9c4b7eb6`)
- [x] **Display toggle** — runtime-only (NOT persisted; transient overlay) in
  uiStore + DisplayMenu Overlays group + i18n. (`aaa6bbb7`)
- [x] **Perf: distance field skips the trig solve** — `station_refs_in_order()`;
  `distance_field_from(&[StationRef])`; command no longer calls
  `compute_station_coordinates`. Validated: enumeration == computed order;
  coordinate-invariant. (`fd046db7`)
- [x] Telemetry event (append-only) — `command.get_station_distances_from`
  added (Rust + worker), len 317→318. (`9c4b7eb6`)
- [ ] **Phase 2 — Render (Approach A)**: SurveyLayer `setFeatureState` +
  paint-swap interpolate (gold→purple, grey=unreachable), **re-applied in
  `updateVisualState()` so it survives setData rebuilds** (the #1 risk);
  `useDistanceGradient` fetch effect; click-to-pick; depth mutual-exclusion.
- [ ] **Phase 3 — Legend + origin marker + e2e** (mirror `depth-gradient.spec.ts`).
- [ ] Verification (cargo ✅; tsc/vitest/test:ui after Phase 2/3).

> **Approved approach + full validation plan:** see
> `~/.claude/plans/imperative-chasing-snowflake.md` (Approach A; feature-state
> survives-rebuild is the key test; runtime-only toggle decided). Backend/IPC is
> done & green; remaining work is the visual render (Phase 2/3), held for Nico's
> review per the validation-first request.

### Resolved: toggle persistence → **runtime-only**
The distance-gradient toggle is NOT persisted (transient overlay; defaults to the
entrance each session) — a plain uiStore field + a DisplayMenu item that bypasses
`saveDisplaySetting`, avoiding the cross-stack Rust/ts-rs change. Done in
`aaa6bbb7`.

## Context

Issue #34 asks to **color the map as a gradient by distance from a user-chosen
point**, with two open questions noted on the issue: distance *metric* and color
*scale*. The intended outcome is a survey-wide overlay that answers "how far is
everything from *here*?" — e.g. from the entrance, a sump, or a stage drop.

## Key domain insight

In cave diving the distance that matters is **along-the-guideline penetration
distance**, not straight-line distance through rock. The app already computes and
displays *max* penetration distance (`DetailPanel.tsx:1119`). So the meaningful
feature is: **pick a station, color every passage by along-line distance from
it.** This directly resolves the issue's "metric" open question.

## Architecture principle (DECIDED)

**Graph / geometry / distance math lives in the Rust domain layer
(`src-tauri/src/models/`) behind a clean, reusable interface. The UI only
*consumes* distance results over IPC — no graph or geometry math in React.**

The same engine then serves three consumers: SVG/stickmap **export**, this
**distance-gradient** overlay, and a future **gas-planning** mode.

**Existing engine to build on:** `Project::compute_penetration_distances`
(`src-tauri/src/models/project.rs:5836-5935`) — a multi-source Dijkstra from
zero-datum stations; shots weighted by `shot.length`; station merges and aligned
loop closures as zero-cost edges. Already IPC-fronted via
`get_project_state_impl` (`commands/project.rs:87`).

**Interface refactor (the reusable seam):**
1. Extract the inline adjacency build (`project.rs:5851-5893`) into
   `build_survey_graph(stations, index) -> Vec<Vec<(usize, f64)>>`.
2. Generalize the Dijkstra into `compute_distances_from(roots: &[usize]) ->
   Vec<f64>` (multi-source; works for zero-datums *or* an arbitrary station).
3. `compute_penetration_distances` becomes a thin caller (`roots` = zero-datums)
   — single source of truth, shared with export.

## Decisions & tradeoffs *(walk Daniel through this)*

| # | Decision | Choice | Why / tradeoff | Status |
|---|----------|--------|----------------|--------|
| 1 | **Metric**: along-passage vs straight-line | **Along-passage** | Matches diver mental model (penetration / gas planning); meaningful in twisty passage. Implied by reusing the penetration algorithm (#3). | **DECIDED** |
| 2 | **Origin type**: a chosen station vs a free x,y point | **Any chosen station** (snap to nearest) — no free-point mode | A free point in a cave could land in **solid rock / be unreachable**, so distance from it is meaningless. The origin *must* be a real survey station. (This is the correct model, not a compromise — safe to champion to Daniel.) Euclidean free-point fallback **dropped**. | **DECIDED** |
| 3 | **Compute location & algorithm** | **Backend; reuse the existing penetration Dijkstra**, generalized to start from a chosen station (not a new algorithm) | Single source of truth + separation of concerns; same engine serves export, this overlay, gas-planning. One IPC call returns all distances. | **DECIDED** |
| 4 | **Interaction**: context-menu vs toggle+click vs toolbar tool | **Display-menu toggle; defaults to distance-from-entrance, override by click-to-pick.** Toggle on → *immediately* colors by penetration distance from the map's zero-datum / entrance(s) — no empty "pick first" state. Click a station to re-root to it; clicking another re-picks; toggle off clears. | Useful the instant it's toggled; the common "how far from the entrance" case is the zero-config default. Mirrors the depth-gradient toggle. Transient pick state is a lightweight flag — **not** a restored toolbar tool. | **DECIDED** |
| 5 | **Color scale + legend** | **Auto-scale 0→farthest reachable + on-screen legend** (ticks); unreachable greyed. Ramp is **sourced from the app's shared palette** so it respects the user's colorblind choice — **#34 contains no colorblind logic of its own** (that's entirely #75). | Readable by default; legend essential. Colorblind is global, not feature-local. Fixed user max (cross-survey comparison) deferred as a later option. | **DECIDED** |
| 6 | **What gets colored** | Shots **and** stations (mirror depth gradient) | Consistency with the existing depth-gradient rendering path. | Proposed |
| 7 | **Vs. depth gradient** | Mutually exclusive (one `line-color` winner); enabling distance gradient suspends depth gradient | Avoids ambiguous double-encoding of color. | Proposed |
| 8 | **Performance** | Rebuild graph per query now; memoize adjacency on `Project` (invalidate on edit) if needed | O(shots); fine at current sizes (hundreds of shots). | Note |

## Colorblind palette — OUT OF SCOPE for #34 (owned by [#75])

The app-wide, user-settable colorblind palette is **entirely #75's work** — the
setting, the Settings UI, and retrofitting existing encoders (depth, error,
export). **#34 does no colorblind work.** It simply **reads its ramp from the
app's active palette** so it respects whatever the user has chosen (colorblind or
not). No palette-building, no setting, no deficiency-type handling here.

> **Soft dependency:** #34 sources its ramp via the shared palette accessor that
> #75 owns. If #75 hasn't landed, #34 reads through the same accessor with a
> sensible default ramp — so wiring #75 in later requires no #34 changes.

## Implementation outline

**Backend (`src-tauri/`)** — pure, testable, no UI/SVG coupling:
- `models/project.rs`: extract `build_survey_graph`; add
  `compute_distances_from(roots)`; keep `compute_penetration_distances` as a
  caller. **Default origin (no picked station) = zero-datum(s)**, i.e. exactly
  `compute_penetration_distances` (roots = zero datums); a picked station =
  `compute_distances_from([picked])`. Same function, different roots. Unit tests:
  distance from a chosen station, unreachable = `INFINITY`, merge/closure
  zero-cost edges, default == penetration.
- `commands/project.rs`: new command
  `get_station_distances_from(from: Option<StationRef>) -> Option<DistanceField>`
  where **`None` = the zero-datum default** and `Some(ref)` re-roots to that
  station; `DistanceField = { distances: Vec<f64>, station_refs: Vec<StationRef>,
  max_reachable: f64 }` (lets the UI map index→ref and scale). ts-rs export.
- Regenerate IPC types: `pnpm gen:ipc-types` (never hand-edit `src/types/ipc/`).
- Telemetry: append-only events for enabling the gradient / setting origin
  (`telemetry/registry.rs`, frozen-ID rules).

**Frontend (`src/`)** — consumes results only:
- `store/uiStore.ts`: `distanceGradientOrigin: StationRef | null`,
  `showDistanceGradient: boolean` + setters (UI state, no math). `origin === null`
  means **default = the map's zero-datum** (entrance penetration), *not* an empty
  state — the IPC call passes `None`.
- `DisplayMenu.tsx` + `displaySelectors.ts`: `showDistanceGradient` toggle in the
  Overlays group. Turning it **on** → fetch with `None` (entrance default) and
  color immediately; turning it **off** clears origin + gradient.
- `hooks/useMapTools.ts`: while `showDistanceGradient` is on, a station click
  re-roots `distanceGradientOrigin` (re-fetch with `Some(ref)`); clicking another
  re-picks. Lightweight transient handling — **not** a new `ToolType` member (we
  just removed tools). A subtle hint conveys "click a station to re-root."
- Data flow: on origin change → IPC call → stash distance field; pass into
  `surveyLayer/features.ts::buildSurveyFeatures` to stamp `distanceFromOrigin` on
  shot/station features; `SurveyLayer` paint uses a MapLibre `interpolate`
  expression on that property when the toggle is on (template: the existing
  depth-gradient paint).
- Legend component (color bar + ticks), distinct **origin marker**, grey for
  unreachable. `i18n/locales/en.json` strings. The ramp comes from the shared
  palette accessor (#75) — no colorblind logic in this layer.

## Open questions for Daniel
None blocking — all #34 decisions settled (below). Colorblind ramp/deficiency
detail lives in [#75], not here. This section is Daniel's chance to push back on
the tradeoffs, not a blocker.

### Resolved
- ~~Free-point vs station~~ → **station only** (free point could be solid rock).
- ~~Reuse vs new algorithm~~ → **reuse** the penetration Dijkstra (generalized).
- ~~Metric~~ → **along-passage**.
- ~~Colorblind bundle vs split~~ → **split** ([#75]); #34 builds + consumes seam.
- ~~Interaction model~~ → **Display toggle → click-to-pick**.
- ~~Multi-source / default origin~~ → **default = the map's zero-datum**
  (entrance penetration); click a station to re-root. Multi-source falls out of
  the engine for free.
- ~~Jumps vs references in reachability~~ → include jumps, exclude references
  (references double-count; missing jumps falsely show cave as unreachable).
  Model conflates them in `is_reference`, so a **temporary connectivity heuristic**
  (keep bridging `is_reference` shots, drop redundant ones) on **one shared
  graph**; real distinction tracked in **[#77]**. *Daniel may want to weigh in —
  this shifts existing penetration/export numbers.*

## Verification
- `cargo test --manifest-path src-tauri/Cargo.toml` (+ `--features telemetry`
  for registry): distances-from-station correctness, unreachable, zero-cost
  edges.
- `pnpm gen:ipc-types` clean; `pnpm tsc --noEmit`.
- `pnpm test:ui`: Display-menu toggle colors the map from the entrance + legend
  appears; clicking a station re-roots; toggle off clears; depth-gradient mutual
  exclusion.
- Manual (`./scripts/dev.sh`): pick entrance → gradient + legend; pick a deep
  station → recolors; unreachable greyed; origin marker visible.

## Doc changelog
- **2026-06-06** — Initial draft. Architecture decided (backend engine behind a
  reusable interface). UX decisions 1,2,4,5,6,7 proposed; pending Nico + Daniel.
- **2026-06-06** — Nico's calls locked: metric=along-passage, origin=station
  only (free-point dropped: could be solid rock), reuse the penetration
  algorithm (generalized), color ramps honor an **app-wide colorblind setting**
  in Settings. Decisions 1,2,3,5 → DECIDED. Added cross-cutting colorblind scope
  (recommend splitting to its own issue). Remaining: interaction model (#4),
  colorblind bundle-vs-split, multi-source preset.
- **2026-06-06** — Colorblind work **split → #75** (#34 builds + consumes the
  palette seam). Interaction model = **Display toggle → click-to-pick**
  (decision #4 DECIDED).
- **2026-06-06** — **Default origin = the map's zero-datum** (entrance
  penetration) on toggle-on; click a station to re-root. IPC takes
  `Option<StationRef>` (`None` = default). Resolves the multi-source question.
- **2026-06-06** — Scope tightened: **#34 does zero colorblind work**; it only
  reads the active palette (owned by #75) so it respects the user's choice. No
  open #34 questions remain — ready to build.
- **2026-06-06** — Built: backend seam refactor (`7e938f88`) + **jump-vs-reference
  reachability heuristic** (`626b2f95`). Jumps counted, redundant references
  dropped, on one shared graph (penetration/export included). Heuristic is
  temporary; real model distinction tracked in **#77**. Full Rust suite green.
