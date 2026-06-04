# Loop Closures (Current Behavior)

This document summarizes how loop closures work in the current codebase (post-removal of Sequential/KeepRaw/Manual strategies).

## Measured vs Closure-Adjusted (non-destructive display mode)

Closure adjustment is a **non-destructive, toggleable display mode**, not a destructive
command. The measured survey geometry (raw shots) is always the source of truth and is
**never rewritten** by adjustment.

- The **Display** dropdown has a *Geometry* control with two modes: **Measured** (raw) and
  **Closure-adjusted** (loop-closure-corrected). The mode is persisted per the display
  settings ("remember last used"); default is Measured. The adjusted option is disabled when
  the project has no closures eligible for the solve (`Batch` / `LeastSquaresWeighted`); `Move`
  closures are already coincident, so a project with only those shows the option disabled.
- Closure-adjusted coordinates are derived by running the weighted least-squares solve on a
  **throwaway clone** of the project (`Project::compute_adjusted_station_coordinates`) and
  returning only the resulting coordinates — the live project's shots/offsets are untouched.
  Because the solve always starts from intact measured data, adding/removing closures
  re-solves accurately instead of compounding on already-adjusted geometry.
- The adjusted view is **read-only**: geometry-mutating tools are disabled there (edits are
  made in the Measured view). Selection, inspection, and measuring remain available.
- The adjusted set is fetched lazily via the `get_adjusted_stations` IPC command, memoized in
  a transient `AppState` cache keyed on `(modified_at, closure-config hash)` and cleared on
  every command/undo/redo. The solve runs on a blocking thread; the map shows a
  "computing closure…" indicator on the first switch for large surveys.
- Headline stats (penetration distance, length, depth) are always computed from **measured**
  geometry.

There is **no** longer an "Adjust Closures" dialog or an `adjust_loop_closures` command — the
old destructive apply path was removed.

> Migration: a project whose shots were already baked by a *previous* destructive adjustment
> cannot recover its original measurements (they were overwritten and never stored). Such a
> project opens looking identical (legacy closures keep `is_aligned = true`) and is never
> rewritten again.

## Strategy Summary

| Strategy | When used | What it does |
|----------|-----------|--------------|
| `ProportionalByLength` | Deferred | Legacy strategy; create-time distribution is disabled and not exposed in the UI (only revisited if users request it). |
| `EqualDistribution` | Deferred | Legacy strategy; create-time distribution is disabled and not exposed in the UI (only revisited if users request it). |
| `Batch` | Create loop closure | Records the closure only; participates in the closure-adjusted display solve. |
| `LeastSquaresWeighted` | Closure-adjusted view | Weighted least-squares solve over the connected component (derived, non-destructive). |
| `Move` | Snap-to-merge workflow | Closure created during a move; no extra distribution at create time. |

Removed strategies:
- `Sequential` (no longer available; legacy string maps to `LeastSquaresWeighted`).
- `KeepRaw` / `ManualAdjustment` (legacy strings map to `Batch`).

## Create Loop Closure

Validation rules:
- Both stations must exist.
- Stations cannot already be merged.
- Stations must be in the same connected component (merges + closures),
  **unless** both sections are connected to zero datums via merges (see `section_has_zero_datum`).
  This zero-datum check uses merge-only connectivity (closures are ignored).
- Duplicate closure pairs are rejected.

Metrics are computed from current station coordinates:
- Misclosure distance and horizontal/vertical components are computed from current raw station coordinates.
- Path length is computed via `calculate_path_length_between`, which treats merges and **existing closures** as zero-distance edges. This can shorten the path length if other closures already exist.
- Error percentage = misclosure / path length * 100 (0 if path length is 0).

Create-time distribution strategies (`ProportionalByLength`, `EqualDistribution`) are **deferred** and not available in the UI (only revisited if users request them). Loop closures are currently recorded only (`Batch`), unless created by the Move workflow.

## Deferred: Distribution at Create Time (Proportional/Equal)

These algorithms remain in the codebase for possible future use, but are **disabled** today.

The adjustment path uses `shortest_path_shots_merges`:
- Edges are **shots + merges only** (closures are not used for this path).
- Co-located groups are based on merges + loop closures (current behavior treats all closures as co-locating).
- When building targets, steps that stay inside the same co-located group are skipped.

Key behaviors:
- If one endpoint’s co-located group contains a zero datum, that side is treated as the anchor and the path is oriented from anchored -> unanchored.
- If a zero-datum station lies **on** the loop path (via merges) **and is not an endpoint**,
  it becomes the anchor and the correction is split across both legs (anchor -> A, anchor -> B).
- If the zero datum is an endpoint, the correction is distributed along the path from that endpoint to the other.
- If **multiple** zero-datum stations appear on the loop path, the operation fails with an error.
- If no zero datum is on the path, the correction is applied along the chosen loop path between A and B.
- If **no loop path exists** (e.g., two zero-datum sections that are not connected), the algorithm falls back to
  `shortest_path_to_any_zero_datum()` for each endpoint and distributes the correction along those two legs.
- Corrections are distributed per-shot either proportionally by length or equally.
- Targets are computed per co-located group, and the same delta is applied to all members of a group.
- Zero-datum stations are never moved; if a computed delta would move one, the operation fails.
- After application, the endpoints are checked for residual misclosure; if still misaligned, the non-anchored side is moved as a final fix (errors if both sides are anchored).

Implementation note:
- The final deltas are applied via `apply_station_move_internal`, which adjusts adjacent shots to absorb the move. This means
  branch shots connected to moved stations may have their length/azimuth/pitch updated to preserve endpoint positions.

Common error conditions:
- `Inconsistent target coordinates ...` when a co-located group is reached by different paths with conflicting targets.
- `Multiple zero datum stations in closure path` when the loop path crosses more than one datum.
- `No distributable shots found ...` if the path collapses to merges/co-located edges (total length or shot count = 0).
- `Closure distribution would move a zero datum station` if a computed delta touches a datum station.
- `Closure distribution failed to align endpoints` if residual misclosure remains and both sides are anchored.

## Closure-Adjusted Solve (LeastSquaresWeighted)

The closure-adjusted view solves with **only** `LeastSquaresWeighted`. It runs
non-destructively on a throwaway clone (`Project::compute_adjusted_station_coordinates`),
once per connected component that has eligible closures, anchored on a zero datum when present
and otherwise on a deterministic default anchor (the lexicographically smallest
`(section_id, station_index)` station in the component, via `default_anchor_for_component`).
Eligible closures are `Batch` + `LeastSquaresWeighted` (`Move` closures are already coincident).

Algorithm overview (unchanged math; the only change is *where* it writes — a clone, not the
live project):
- Build constraint groups where stations connected via merges **or closures** are in the same group.
- If a group contains a zero datum, it is fixed; multiple zero datums in a single group is an error.
- If no zero datum exists in the component, the anchor station's group is fixed.
- For each shot, build weighted constraints in X/Y using section quality and base sigmas from config:
  - `base_sigma_length_m`
  - `base_sigma_azimuth_deg`
  - `base_sigma_depth_m` (depth is not adjusted — the solve is horizontal-only)
- Solve independent least-squares systems for X/Y using a sparse Jacobi-preconditioned
  Conjugate Gradient solver (see [performance.md](performance.md) for algorithm details).
- Update the clone's shot vectors from solved group coordinates and apply section-level
  translations to keep merged stations aligned, then compute coordinates from the clone.
- Zero datum positions are verified to remain fixed; any movement is an error.

## Co-location and Move Tools

Closures are treated as co-location relationships **only after alignment** (like merges):
- Dragging a station moves all stations in its merge set plus any **aligned** closures.
- Before batch adjustment, closure endpoints move independently (not co-located).
- Immovable stations (zero datums and their merge/aligned-closure neighbors) are computed via BFS over merges + aligned closures.
- There is no longer a KeepRaw exception; closure participation is gated by alignment.

## Legacy Strategy Mapping

For backward compatibility with stored projects:
- `KeepRaw` -> `Batch`
- `ManualAdjustment` -> `Batch`
- `Sequential` -> `LeastSquaresWeighted`

These mappings are handled in `ClosureStrategy::from_str_lossy` and via serde aliases.

## Files of Interest

- `src-tauri/src/models/station.rs` (ClosureStrategy enum + legacy mapping)
- `src-tauri/src/models/project.rs` (create logic; `adjust_loop_closures` solver kept as the
  internal derivation helper; `compute_adjusted_station_coordinates`; `default_anchor_for_component`)
- `src-tauri/src/commands/project.rs` (`get_adjusted_stations` IPC command)
- `src-tauri/src/core/state/app_state.rs` (transient closure-adjusted cache)
- `src/components/Dialogs/ClosureDialog.tsx` (create closure UI)
- `src/components/SingleSystemView/DisplayMenu.tsx` (Geometry mode toggle)
- `src/store/geometrySelectors.ts` (active-geometry selectors)
- `docs/move-tools.md` (move tool behavior + co-location rules)
