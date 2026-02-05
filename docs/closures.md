# Loop Closures (Current Behavior)

This document summarizes how loop closures work in the current codebase (post-removal of Sequential/KeepRaw/Manual strategies).

## Strategy Summary

| Strategy | When used | What it does |
|----------|-----------|--------------|
| `ProportionalByLength` | Deferred | Legacy strategy; create-time distribution is disabled and not exposed in the UI (only revisited if users request it). |
| `EqualDistribution` | Deferred | Legacy strategy; create-time distribution is disabled and not exposed in the UI (only revisited if users request it). |
| `Batch` | Create loop closure | Records the closure only; no immediate geometry adjustment. |
| `LeastSquaresWeighted` | Adjust loop closures (batch) | Weighted least-squares adjustment over the connected component. |
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

## Batch Adjustment (LeastSquaresWeighted)

`Adjust Loop Closures` currently supports **only** `LeastSquaresWeighted`.

Inputs:
- `anchor_station` (used only if the component has no zero datum).
Adjustment currently uses **batch closures only** (plus the selected method).

Algorithm overview:
- Build constraint groups where stations connected via merges **or closures** are in the same group.
- If a group contains a zero datum, it is fixed; multiple zero datums in a single group is an error.
- If no zero datum exists in the component, the anchor station's group is fixed.
- For each shot, build weighted constraints in X/Y/Z using section quality and base sigmas from config:
  - `base_sigma_length_m`
  - `base_sigma_azimuth_deg`
  - `base_sigma_depth_m`
- Solve independent least-squares systems for X/Y/Z.
- Update shot vectors from solved group coordinates and apply section-level translations to keep merged stations aligned.
- After adjustment, zero datum positions are verified to remain fixed; any movement is an error.

## Co-location and Move Tools

Closures are treated as co-location relationships (like merges):
- Dragging a station moves all stations in its merge/closure co-location set.
- Immovable stations (zero datums and their closure/merge-connected neighbors) are computed via BFS over merges + closures.
- There is no longer a KeepRaw exception; all closures participate in co-location.

## Legacy Strategy Mapping

For backward compatibility with stored projects:
- `KeepRaw` -> `Batch`
- `ManualAdjustment` -> `Batch`
- `Sequential` -> `LeastSquaresWeighted`

These mappings are handled in `ClosureStrategy::from_str_lossy` and via serde aliases.

## Files of Interest

- `src-tauri/src/models/station.rs` (ClosureStrategy enum + legacy mapping)
- `src-tauri/src/models/project.rs` (create/distribute/adjust logic)
- `src/components/Dialogs/ClosureDialog.tsx` (create closure UI)
- `src/components/Dialogs/AdjustClosuresDialog.tsx` (batch adjustment UI)
- `docs/move-tools.md` (move tool behavior + co-location rules)
