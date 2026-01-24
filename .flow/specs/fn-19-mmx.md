# Zero Datum Positioning and Connected Section Repositioning

## Overview

When a zero datum (GPS reference point) is set on a station, the station should be positioned at those exact coordinates on the map, and all sections connected through station merges should move relative to the zero datum station. Currently, `set_zero_datum` only stores the GPS coordinates but does not reposition the station or connected sections.

## Scope

**In scope:**
- GPS-to-local coordinate conversion (ENU projection with alt=0)
- Section repositioning via `section_offsets` when datum is set
- Removal of global primary_zero_datum subtraction (rely solely on section_offsets)
- Enhanced undo to capture and restore section_offsets directly
- Validation improvements for duplicate datum in connected group
- Frontend fit-to-bounds after datum set

**Out of scope:**
- Merge undo restoring section_offsets (existing limitation)
- GPS coordinate validation against external services
- Export coordinate conversion (GPS output)
- Visual preview before repositioning

## Quick commands

```bash
# Rust tests
cargo test --manifest-path src-tauri/Cargo.toml

# Type check frontend
pnpm tsc --noEmit

# Run app
./scripts/dev.sh
```

## Approach

### Critical Architecture Decision: Remove Global Subtraction

**Problem identified**: Current `compute_station_coordinates_with_progress` subtracts `primary_zero_datum()` coordinates globally. This means:
1. Removing the first datum changes what gets subtracted, shifting all stations
2. Setting first datum would move unconnected sections unless offsets are applied

**Solution**: Remove the global subtraction step entirely. Rely solely on `section_offsets` for positioning:
- When first datum is set, compute and apply offset to connected group so datum station lands at (0,0)
- When subsequent datums are set, compute offset from first datum's GPS position
- When datum is removed, section_offsets remain unchanged (positions stable)
- This eliminates the coupling between `zero_datums` order and station positions

### GPS-to-Local Conversion

Implement ENU (East-North-Up) projection using WGS84 ellipsoid:
1. Convert geodetic (lat, lon, **alt=0**) to ECEF (x, y, z)
2. Convert ECEF difference to ENU (east, north, up)
3. First datum GPS becomes projection center
4. **Important**: Use alt=0 for both points, ignore `depth_reference` (it's not ellipsoid height)
5. Local coordinates: East→x (meters), North→y (meters)

### Section Repositioning (set_zero_datum)

1. Call `get_connected_section_ids()` to find all affected sections
2. Compute current station position via `compute_station_raw_coords()`
3. **For first datum**: Compute offset so station's raw coords become (0,0), apply to connected sections
4. **For subsequent datums**: Compute GPS offset from first datum in meters, then compute offset so station lands there
5. Store GPS in `zero_datums` vector
6. Return success

### Undo Implementation (state.rs)

**Key insight**: Undo is implemented in `state.rs`, not just `undo.rs`. The current pattern calls `set_zero_datum`/`remove_zero_datum` on undo, which would recompute offsets.

**Fix**: In `state.rs`:
1. Before executing SetZeroDatum, capture `previous_offsets` for all affected sections
2. On undo, restore `section_offsets` directly from captured values (don't call `set_zero_datum`)
3. Also track which offsets didn't exist (new keys) vs existed (restore value)

### merge_projects Compatibility

Current `merge_projects` in `state.rs:1581` calls `set_zero_datum`. After our changes, this would reposition sections during merge.

**Solution**: Add internal helper `Project::store_zero_datum_without_repositioning()` for use by merge/import paths that need to preserve copied offsets.

### Existing Validation

Review found that `Project::set_zero_datum()` already calls `find_connected_zero_datum()` for validation. Task 5 should confirm this behavior and improve the error message, not duplicate logic.

## Key Files

| File | Changes |
|------|---------|
| `src-tauri/src/models/project.rs` | Add GPS conversion, enhance set_zero_datum, remove global subtraction, add store helper |
| `src-tauri/src/core/state.rs` | Enhance undo to capture/restore offsets directly |
| `src-tauri/src/core/undo.rs` | Enhance ZeroDatumInfo with offsets |
| `src/store/projectStore.ts` | Call triggerFitToBounds after datum |
| `docs/SPEC.md` | Document zero datum behavior |

## Edge Cases

- First datum removal: Section offsets unchanged, positions stable
- Subsequent datum removal: Offsets unchanged, positions stable
- First datum on station with existing offset: Compute additional offset to reach (0,0)
- merge_projects: Use store-only helper to preserve source offsets
- Empty section: Valid to set datum (station still exists)
- GPS altitude: Always use alt=0 for conversion, ignore depth_reference

## Risks

| Risk | Mitigation |
|------|------------|
| Merge undo doesn't restore offsets | Document as existing limitation, out of scope |
| merge_projects behavior change | Add store-only helper for backward compatibility |
| GPS conversion accuracy | Use proper ENU with WGS84 constants |

## Test Notes

- Test first datum sets station to (0,0) via offset
- Test second datum on different group uses GPS offset
- Test duplicate datum on same group returns error with station ID
- Test undo restores previous section_offsets directly
- Test remove datum keeps positions unchanged
- Test ENU conversion with known values (small deltas at equator, 0.01 degree tolerance)
- Test merge_projects still works (uses store-only helper)

## Acceptance

- [ ] Setting zero datum repositions station to GPS coordinates via section_offsets
- [ ] First zero datum station becomes local (0,0,z) via offset application
- [ ] All transitively connected sections reposition relative to the datum
- [ ] Global primary_zero_datum subtraction removed from compute_station_coordinates
- [ ] Second datum's local position computed from GPS offset relative to first datum
- [ ] Error shown when trying to set datum on already-referenced station group (with station ID)
- [ ] Setting datum is fully undoable (restores exact previous section_offsets)
- [ ] Removing datum keeps positions (offsets unchanged)
- [ ] Map view fits to bounds after datum is set
- [ ] GPS coordinates validated (-90/90 lat, -180/180 lon)
- [ ] ENU conversion uses alt=0, ignores depth_reference
- [ ] merge_projects uses store-only helper (no repositioning during merge)
- [ ] Z-coordinates (depths) are preserved
- [ ] Unconnected sections maintain position when first datum is set

## References

- Epic spec: `.flow/specs/fn-19-mmx.md`
- Current set_zero_datum: `src-tauri/src/models/project.rs:539-564`
- Section offsets: `src-tauri/src/models/project.rs` (`section_offsets` field)
- Connected groups: `src-tauri/src/models/project.rs:202-222`
- Undo handler: `src-tauri/src/core/state.rs` (undo for SetZeroDatum)
- merge_projects: `src-tauri/src/core/state.rs:1581`
- ENU projection: Wikipedia Local_tangent_plane_coordinates
