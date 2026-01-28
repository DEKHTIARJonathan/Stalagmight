# Fix Merge/Closure Separation: Undo Bug, Remove Merge Line, New Dialogs

## Overview

Merge and loop closure are currently conflated in `merge_stations()` (`src-tauri/src/models/project.rs:354-473`). When two already-connected stations are "merged", the function creates BOTH a `StationMerge` AND a `LoopClosure` — but these are mutually exclusive operations. Additionally, `unmerge_stations()` (`project.rs:476-489`) does not remove closures, so undoing a merge leaves an orphaned closure line on the map.

This epic separates the two operations entirely:
- **Merge** = connect unconnected sections (moves sections, creates `StationMerge` only)
- **Closure** = record misclosure between already-connected stations (no movement, creates `LoopClosure` only)

### Scope

1. **Rust backend**: New `check_merge_connectivity` read-only invoke, new `CreateLoopClosure` command with undo/redo, fix `MergeStations` to reject connected stations, fix `UnmergeStations` to clean up closures
2. **Frontend**: Replace current MergeDialog with simple confirmation, add new ClosureDialog with preview data, update merge tool flow to call connectivity check first
3. **Map**: Remove `survey-merges` layer entirely (merged stations always overlap — the cyan line is useless)
4. **Docs**: Update SPEC.md sections for commands, dialogs, and workflow

## Approach

### Connectivity check (read-only invoke, not a Command)
- Add `check_merge_connectivity` to `src-tauri/src/commands/station.rs` — calls existing `get_connected_section_ids()` at `project.rs:204` and `calculate_path_length_between()` at `project.rs:279`
- Returns `ConnectivityResult { connected: bool, preview: Option<ClosurePreview> }` where `ClosurePreview` contains path_length, misclosure_distance, error_percentage, horizontal_misclosure, vertical_misclosure
- Register in `lib.rs:435-440` alongside other station commands

### CreateLoopClosure command
- New variant in `Command` enum at `command.rs:67`
- Fields: `station_a: StationRef, station_b: StationRef, closure_strategy: ClosureStrategy`
- Execution: Extract closure calculation from current `merge_stations()` lines 370-413 into a standalone `create_loop_closure()` method
- Undo: New `UndoData::ClosureInfo` variant storing full `LoopClosure` struct (follow `ShotSnapshot` pattern — store full data, don't recalculate)
- Redo: Re-execute the command (standard pattern at `undo.rs:553-556`)

### MergeStations fix
- Remove the "connected sections → create closure" branch (lines 370-413 of `project.rs`)
- Return `Err(...)` if sections are already connected (let frontend route to closure flow instead)
- Remove `_strategy` parameter from `MergeStations` command variant (strategy only applies to closures)

### UnmergeStations fix
- After removing the merge, also remove any closures where either station matches `station_a` or `station_b` of the closure
- Update undo data to capture removed closures for restore on redo

### Frontend dialog flow
- In `useMapTools.ts:116-136`: After selecting station B, call `check_merge_connectivity` invoke BEFORE opening any dialog
- If not connected → open simplified MergeDialog (station names + confirm/cancel)
- If connected → open new ClosureDialog with preview data from connectivity check
- ClosureDialog: Shows error %, path length, misclosure, H/V breakdown using existing distance formatting (`toFixed(2)` for distances). Includes `ClosureStrategy` selector. Follow `DialogWrapper` pattern from existing dialogs.

### Map layer removal
- Remove `survey-merges` layer, source, and `buildMergeFeatures` from `SurveyLayer.tsx` and `features.ts`
- Remove `mergesLayerId` constant and all references
- Keep `survey-loop-closures` layer unchanged

## Risks / Dependencies

| Risk | Mitigation |
|------|------------|
| Undo data backward compatibility — existing undo entries may have `MergeInfo` for operations that created both merge + closure | On undo of `MergeInfo`, also clean up any closures for the same station pair (defensive cleanup) |
| `calculate_path_length_between` BFS may return incorrect path length for complex networks | Existing function already handles this; connectivity check reuses it without changes |
| Removing merge layer may break existing map tests | Search for `survey-merges` in test files and update |
| `UnmergeStations` undo currently only stores first merge (line 174 of state/undo.rs) | This is an existing bug unrelated to this epic; note it but don't fix (scope creep) |

## Quick commands

```bash
# Type check
pnpm tsc --noEmit

# Rust tests
cargo test --manifest-path src-tauri/Cargo.toml

# E2E tests
pnpm test:ui
```

## Acceptance

- [ ] Merge and closure are mutually exclusive — merging unconnected stations creates only a StationMerge; closing connected stations creates only a LoopClosure
- [ ] `survey-merges` map layer, source, and feature builder code are completely removed
- [ ] New `check_merge_connectivity` Tauri invoke returns connectivity status + full closure preview data
- [ ] New `CreateLoopClosure` command variant with full undo/redo support
- [ ] MergeDialog simplified to station-names-only confirmation (no strategy selector, no distance info)
- [ ] New ClosureDialog shows full preview data (error %, path length, misclosure distance, H/V) with strategy selector
- [ ] Correct user flow: connectivity check → appropriate dialog → appropriate command
- [ ] Undo of loop closure removes the closure entry and line from map
- [ ] Redo of loop closure re-adds the closure entry and line
- [ ] UnmergeStations also removes closures involving the station
- [ ] Duplicate merge/closure between same station pair is prevented
- [ ] Same-section closures are allowed
- [ ] Existing tests updated, new tests added for closure undo/redo, dialog flows, and connectivity check
- [ ] Distance/error values in ClosureDialog use existing app formatting conventions
- [ ] SPEC.md updated for changed commands, dialogs, and workflow

## References

| File | Lines | What |
|------|-------|------|
| `src-tauri/src/core/command.rs` | 67-74 | Command enum (MergeStations, UnmergeStations) |
| `src-tauri/src/core/state/commands.rs` | 67-72 | Command execution dispatch |
| `src-tauri/src/core/state/undo.rs` | 153-184 | Merge undo data generation |
| `src-tauri/src/core/state/undo.rs` | 396-412 | Merge undo execution |
| `src-tauri/src/core/undo.rs` | 37-100 | UndoData enum |
| `src-tauri/src/models/project.rs` | 204-226 | `get_connected_section_ids()` |
| `src-tauri/src/models/project.rs` | 279-350 | `calculate_path_length_between()` |
| `src-tauri/src/models/project.rs` | 352-489 | `merge_stations()` and `unmerge_stations()` |
| `src-tauri/src/models/station.rs` | 187-199 | `ClosureStrategy` enum |
| `src-tauri/src/models/station.rs` | 254-271 | `LoopClosure` struct |
| `src-tauri/src/commands/station.rs` | 6-38 | Tauri command handlers |
| `src-tauri/src/lib.rs` | 405-475 | Command registration |
| `src-tauri/src/persistence/sqlite.rs` | 269, 339, 408-446, 780 | DB schema + persistence |
| `src/components/Dialogs/MergeDialog.tsx` | 1-191 | Current merge dialog |
| `src/components/Map/SurveyLayer.tsx` | 65, 234, 424, 1487 | Merges layer setup |
| `src/components/Map/surveyLayer/features.ts` | 244-266 | `buildMergeFeatures` |
| `src/hooks/useMapTools.ts` | 116-136 | Merge tool click handler |
