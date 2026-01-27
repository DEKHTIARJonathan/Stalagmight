# Fix Merge/Closure Separation: Undo Bug, Remove Merge Line, New Dialogs

## Problem

When merging two stations that are already connected through a chain of shots, stations, and merges:

1. **Both a merge entry AND a loop closure entry are created** — but they should be mutually exclusive operations. A merge aligns unconnected sections. A closure records misclosure for already-connected stations.
2. **Two lines appear on the map** — a cyan "merge line" (which should not exist at all, since merged stations always overlap) and a colored "loop closure line".
3. **On undo, only the cyan line disappears** — the loop closure entry is never removed by `unmerge_stations()`, so the closure line stays permanently on the map.
4. **No dialog is shown** — the merge proceeds automatically without asking the user whether they want a closure instead.

## Key Decisions

### Merge vs. Closure Are Mutually Exclusive
- **Merge**: Stations are NOT connected. Sections move to align. Creates a `StationMerge` entry only.
- **Closure**: Stations ARE already connected. Sections do NOT move. Creates a `LoopClosure` entry only. Never both.

### Remove Merge Line Layer Entirely
- The `survey-merges` map layer (cyan dashed lines) should be **removed completely** — merged stations always perfectly overlap, so there is no need for a visual line between them.
- Remove the layer, source, and feature builder code (`buildMergeFeatures` in `features.ts`).

### Preemptive Connectivity Check
- Add a new **Tauri invoke** (read-only query, not through Command enum): `check_merge_connectivity`
- Returns whether two stations are already connected, plus full closure preview data (error %, path length, misclosure distance, horizontal/vertical breakdown).
- Frontend calls this BEFORE attempting any merge.

### New CreateLoopClosure Command
- Add `CreateLoopClosure` as a **separate Command enum variant** (distinct from `MergeStations`).
- Full undo/redo support: undo removes the closure, redo re-adds it.

### Dialog Redesign
- **MergeDialog** becomes a **simple confirmation**: "Merge Station A with Station B?" with Merge/Cancel buttons. No strategy selector. Station names only.
- **New ClosureDialog** component: Shows full preview data (error %, path length, misclosure distance, H/V breakdown) using existing app distance formatting. Includes closure strategy selector. Title: "Create Loop Closure". Button: "Create Closure" / "Cancel".

### User Flow
1. User selects two stations to merge
2. Frontend calls `check_merge_connectivity` (Tauri invoke)
3. If NOT connected → show simple MergeDialog → on confirm → execute `MergeStations` command
4. If connected → show ClosureDialog with preview data → on confirm → execute `CreateLoopClosure` command; on decline → cancel entirely

### Undo/Redo
- `CreateLoopClosure` undo: removes the loop closure entry (from both in-memory `loop_closures` and database). Redo re-adds it.
- `MergeStations` undo: unchanged (removes merge, sections move back).
- `UnmergeStations` command: should also remove any closures involving the station (cleanup).
- Undo data storage approach: follow existing patterns (no strong preference on storing full struct vs. recalculating).

### Loop Closure Line Colors (Unchanged)
- Green (#22c55e): error < 1%
- Yellow (#eab308): error 1-3%
- Orange (#f97316): error 3-5%
- Red (#ef4444): error > 5%

## Edge Cases

- **Same-section closure**: Allow closures between stations in the same section (loop goes through the section's own shots).
- **Duplicate prevention**: If stations are already merged or already have a closure between them (exact same pair), prevent the operation and show an error.
- **No data migration needed**: Feature is fresh enough that no existing projects need migration of orphaned closures.
- **UnmergeStations scope**: When unmerging a station, also remove any loop closures involving that station.

## Open Questions

- Exact undo data strategy for `CreateLoopClosure` (store full struct vs. station pair + recalculate) — decide during implementation based on existing patterns.
- Whether merge undo (sections moving back) currently works correctly — should be verified during testing.

## Acceptance

- [ ] Merge and closure are mutually exclusive — merging unconnected stations creates only a StationMerge; closing connected stations creates only a LoopClosure
- [ ] `survey-merges` map layer, source, and feature builder code are completely removed
- [ ] New `check_merge_connectivity` Tauri invoke returns connectivity status + full closure preview data
- [ ] New `CreateLoopClosure` command variant with full undo/redo support
- [ ] MergeDialog simplified to station-names-only confirmation (no strategy selector)
- [ ] New ClosureDialog shows full preview data (error %, path length, misclosure distance, H/V) with strategy selector
- [ ] Correct user flow: connectivity check → appropriate dialog → appropriate command
- [ ] Undo of loop closure removes the closure entry and line from map
- [ ] Redo of loop closure re-adds the closure entry and line
- [ ] UnmergeStations also removes closures involving the station
- [ ] Duplicate merge/closure between same station pair is prevented
- [ ] Same-section closures are allowed
- [ ] Existing tests updated, new tests added for closure undo/redo, dialog flows, and connectivity check
- [ ] Distance/error values in ClosureDialog use existing app formatting conventions
