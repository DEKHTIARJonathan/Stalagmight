# fn-19-mmx.2 Enhance set_zero_datum to reposition sections

## Description
Enhance `Project::set_zero_datum()` to reposition the station and all connected sections when a GPS reference is set.

**Size:** M
**Files:** `src-tauri/src/models/project.rs`

## Approach

1. Call `get_connected_section_ids()` to find all affected sections
2. Compute current station position via `compute_station_raw_coords()`
3. For first datum (no existing datums): Station becomes (0,0), adjust all connected section offsets so station lands at origin
4. For subsequent datums: Compute GPS offset from first datum using `gps_to_local()`, apply offset to connected sections
5. Store GPS in `zero_datums` vector
6. Trigger coordinate recomputation

Follow pattern from `merge_stations()` at `project.rs:333-443` for offset application.

## Key context

Section positioning uses `section_offsets: HashMap<SectionId, (f64, f64)>`. When computing station coordinates, these offsets are applied. The goal is to compute offsets such that the datum station ends up at its GPS-derived local position.
## Acceptance
- [ ] First datum station repositions to (0, 0, z)
- [ ] All connected sections move with datum station
- [ ] Subsequent datums positioned at GPS offset from first datum
- [ ] Section offsets updated in `section_offsets` HashMap
- [ ] Existing section offsets respected (adjustment, not replacement)
- [ ] Z-coordinates preserved (not affected by GPS)
- [ ] Detailed logging of GPS coords, computed offsets, affected sections
- [ ] Returns success/error result
- [ ] Rust tests pass (cargo test)
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
