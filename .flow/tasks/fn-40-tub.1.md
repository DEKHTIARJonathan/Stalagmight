# fn-40-tub.1 Backend: connectivity check, CreateLoopClosure command, fix MergeStations/UnmergeStations

## Description

Implement backend changes for merge/closure separation: a new read-only connectivity check invoke, a new `CreateLoopClosure` command with undo/redo, fix `MergeStations` to reject already-connected stations, and fix `UnmergeStations` to also remove closures.

**Size:** M
**Files:**
- `src-tauri/src/models/project.rs` — new `create_loop_closure()` method, fix `merge_stations()`, fix `unmerge_stations()`
- `src-tauri/src/core/command.rs` — add `CreateLoopClosure` variant, remove `closure_strategy` from `MergeStations`
- `src-tauri/src/core/state/commands.rs` — dispatch `CreateLoopClosure`
- `src-tauri/src/core/state/undo.rs` — generate/apply undo data for new command, update `MergeStations` undo
- `src-tauri/src/core/undo.rs` — add `ClosureInfo` variant to `UndoData` enum
- `src-tauri/src/commands/station.rs` — new `check_merge_connectivity` handler, new `create_loop_closure` handler
- `src-tauri/src/lib.rs` — register new invokes

## Approach

### 1. New `check_merge_connectivity` invoke (read-only, NOT a Command)
- Add to `src-tauri/src/commands/station.rs` following existing handler patterns (e.g., `merge_stations` at line 6)
- Call `Project::get_connected_section_ids()` at `project.rs:204` to check connectivity
- If connected, also call `compute_station_raw_coords()` and `calculate_path_length_between()` at `project.rs:279` to compute preview data
- Return new `ConnectivityResult` struct: `{ connected: bool, preview: Option<ClosurePreview> }`
- `ClosurePreview`: `{ path_length: f64, misclosure_distance: f64, error_percentage: f64, horizontal_misclosure: f64, vertical_misclosure: f64 }`
- Also check for duplicate: if stations are already merged or already have a closure between them, return an error
- Register in `lib.rs:435` alongside station commands

### 2. New `CreateLoopClosure` command
- Add variant to `Command` enum at `command.rs:67`: `CreateLoopClosure { station_a: StationRef, station_b: StationRef, closure_strategy: ClosureStrategy }`
- Add `description()` match arm (follow existing pattern at `command.rs`)
- Extract closure calculation from `merge_stations()` lines 370-413 into new `Project::create_loop_closure()` method
- Validate: stations exist, not already having a closure between them, stations are connected
- Allow same-section closures (don't reject `station_a.section_id == station_b.section_id`)

### 3. Undo/redo for `CreateLoopClosure`
- Add `UndoData::ClosureInfo` variant to `undo.rs:37` storing the full `LoopClosure` struct (follow `ShotSnapshot` pattern — store full data rather than recalculating)
- In `generate_undo_data()` at `state/undo.rs`: for `CreateLoopClosure`, return `UndoData::None` initially (closure doesn't exist yet pre-execute)
- In `finalize_undo_data()`: capture the newly created `LoopClosure` from the project's `loop_closures` vec
- In `undo()` at `state/undo.rs:396`: for `ClosureInfo`, remove the closure from `project.loop_closures` matching the stored station pair
- Redo uses standard re-execute path at `undo.rs:553-556`

### 4. Fix `MergeStations`
- In `merge_stations()` at `project.rs:370`: instead of creating a closure for connected stations, return `Err("Stations are already connected. Use Create Loop Closure instead.")`
- Remove `closure_strategy` from the `MergeStations` command variant (rename `_strategy` removal)
- Update `MergeStations` handler in `commands/station.rs` to not pass strategy
- Update `UndoData::MergeInfo` — remove `strategy` field since merge no longer uses it
- Update undo generation at `state/undo.rs:153-162` accordingly

### 5. Fix `UnmergeStations`
- In `unmerge_stations()` at `project.rs:476`: after removing the merge, also remove closures where either station matches
- Pattern: `self.loop_closures.retain(|lc| !(lc.station_a == station_a || lc.station_b == station_a || lc.station_a == station_b || lc.station_b == station_b))`
- Use the `station_ref` parameter (which is one of the merged stations) to find and remove relevant closures

## Key context

- Redo for non-snapshot commands works by re-executing the original command (`undo.rs:553-556`). The `CreateLoopClosure` command must be deterministic for redo to work (it recalculates closure values, which is fine since survey data doesn't change).
- The existing `is_undoable()` check at `state/undo.rs` must include `CreateLoopClosure` as undoable.
- Memory pitfall: multi-step undo operations must set isDirty on partial failure.
## Acceptance
- [ ] New `check_merge_connectivity` Tauri invoke registered and working — returns `{ connected: bool, preview: Option<ClosurePreview> }`
- [ ] `check_merge_connectivity` returns error if stations already merged or already have closure between them
- [ ] New `CreateLoopClosure` command variant added to Command enum
- [ ] `CreateLoopClosure` execution creates a `LoopClosure` entry with correct values (path_length, misclosure_distance, error_percentage, horizontal_misclosure, vertical_misclosure)
- [ ] `CreateLoopClosure` undo removes the closure entry from `project.loop_closures`
- [ ] `CreateLoopClosure` redo re-creates the closure entry
- [ ] Same-section closures are allowed
- [ ] Duplicate closure between same station pair is rejected
- [ ] `MergeStations` no longer creates closures for connected stations — returns error instead
- [ ] `MergeStations` no longer has `closure_strategy` parameter
- [ ] `UnmergeStations` also removes closures involving the unmerged station
- [ ] `UndoData::ClosureInfo` variant added with full `LoopClosure` data
- [ ] `UndoData::MergeInfo` `strategy` field removed
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
