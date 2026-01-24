# fn-19-mmx.2 Enhance set_zero_datum to reposition sections

## Description
Enhance `Project::set_zero_datum()` to reposition the station and all connected sections when a GPS reference is set. Also remove the global primary_zero_datum subtraction from coordinate computation.

**Size:** M
**Files:** `src-tauri/src/models/project.rs`

## Approach

**Part 1: Remove global subtraction**
In `compute_station_coordinates_with_progress()`, remove the step that subtracts `primary_zero_datum()` coordinates. Positioning will now be controlled solely by `section_offsets`.

**Part 2: Enhanced set_zero_datum**
1. Call `get_connected_section_ids()` to find all affected sections
2. Compute current station position via `compute_station_raw_coords()`
3. For first datum: Compute offset so station raw coords become (0,0), apply to all connected sections
4. For subsequent datums: Compute GPS offset from first datum using `gps_to_local()`, then compute offset so station lands at that position
5. Store GPS in `zero_datums` vector
6. Return success

**Part 3: Add store-only helper**
Add `Project::store_zero_datum_without_repositioning()` for use by `merge_projects` and import paths that need to copy datums without triggering repositioning.

**Part 4: Update merge_projects to use store-only helper**
Update `merge_projects()` in `state.rs:1581` to call `store_zero_datum_without_repositioning()` instead of `set_zero_datum()` when copying datums from merged project.

Follow pattern from `merge_stations()` at `project.rs:333-443` for offset application.

## Key context

The key insight is that removing global subtraction means:
- First datum positioning must explicitly set offsets to make datum station land at (0,0)
- Remove datum leaves offsets unchanged (stable positions)
- merge_projects needs a bypass to avoid repositioning during merge

## Acceptance
- [ ] Global primary_zero_datum subtraction removed from compute_station_coordinates
- [ ] First datum station repositions to (0, 0, z) via offset application
- [ ] All connected sections move with datum station
- [ ] Subsequent datums positioned at GPS offset from first datum
- [ ] Section offsets updated in `section_offsets` HashMap
- [ ] Z-coordinates preserved (not affected by GPS)
- [ ] `store_zero_datum_without_repositioning()` helper added for merge/import
- [ ] `merge_projects()` in state.rs updated to use store-only helper
- [ ] Detailed logging of GPS coords, computed offsets, affected sections
- [ ] Returns success/error result
- [ ] Rust tests pass (cargo test)

## Done summary
Enhanced set_zero_datum to reposition sections when GPS reference is set: first datum positions station at (0,0) via section_offsets, subsequent datums use GPS offset from first datum. Added store_zero_datum_without_repositioning helper for merge/import paths. Removed global primary_zero_datum subtraction from coordinate computation.
## Evidence
- Commits: d9c3549, 6e22155
- Tests: cargo test --manifest-path src-tauri/Cargo.toml
- PRs: