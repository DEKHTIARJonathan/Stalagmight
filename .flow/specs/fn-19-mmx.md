# Zero Datum Positioning and Connected Section Repositioning

## Overview

When a zero datum (GPS reference point) is set on a station, the station should be positioned at those exact coordinates on the map, and all sections connected through station merges should move relative to the zero datum station. Currently, `set_zero_datum` only stores the GPS coordinates but does not reposition the station or connected sections.

## Scope

**In scope:**
- GPS-to-local coordinate conversion (ENU projection)
- Section repositioning via `section_offsets` when datum is set
- Recompute station coordinates from shots with new origin
- Validation for duplicate datum in connected group
- Enhanced undo data to capture section_offsets
- Merge propagates datum repositioning
- Frontend fit-to-bounds after datum set

**Out of scope:**
- Visual preview before repositioning
- GPS coordinate validation against external services
- Export coordinate conversion (GPS output)

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

### GPS-to-Local Conversion

Implement ENU (East-North-Up) projection using WGS84 ellipsoid:
1. Convert geodetic (lat, lon) to ECEF (x, y, z)
2. Convert ECEF difference to ENU (east, north, up)
3. First datum GPS becomes projection center
4. Local coordinates: East→x (meters), North→y (meters)

WGS84 constants in Rust:
```rust
const WGS84_A: f64 = 6_378_137.0;  // semi-major axis
const WGS84_E2: f64 = 0.00669437999014;  // eccentricity squared
```

### Section Repositioning

Enhance `Project::set_zero_datum()` to:
1. Find all connected sections via `get_connected_section_ids()`
2. Compute current station coordinates via `compute_station_raw_coords()`
3. For first datum: Station becomes (0,0), no offset changes needed
4. For subsequent datums: Compute GPS offset from first datum in meters
5. Calculate offset needed to move station to target position
6. Apply offset to all connected sections via `section_offsets`

### Undo Enhancement

Modify `UndoData::ZeroDatumInfo` to capture:
```rust
pub struct ZeroDatumInfo {
    pub station_ref: StationRef,
    pub previous_gps: Option<GpsCoordinates>,
    pub previous_offsets: HashMap<SectionId, (f64, f64)>,  // NEW
}
```

### Key Files

| File | Changes |
|------|---------|
| `src-tauri/src/models/project.rs` | Enhance set_zero_datum, add GPS conversion |
| `src-tauri/src/core/undo.rs` | Enhance ZeroDatumInfo with offsets |
| `src-tauri/src/models/project.rs` | Merge propagation for datum |
| `src/store/projectStore.ts` | Call triggerFitToBounds after datum |
| `docs/SPEC.md` | Document zero datum behavior |

### Existing Patterns to Follow

- Section offset application: `project.rs:333-443` (`merge_stations`)
- Connected group traversal: `project.rs:202-222` (`get_connected_section_ids`)
- Coordinate computation: `project.rs:596-727` (`compute_station_coordinates`)
- Undo data capture: `undo.rs:72-77` (`UndoData::ZeroDatumInfo`)

## Edge Cases

- First datum removal: Next datum in vector becomes primary (or none)
- First datum on station with existing offset: GPS position overrides offset
- Datum on merged station: Use the section containing the station
- GPS coordinates identical for different groups: Both groups at same position (valid)
- Merge connects to datum group: Merged sections reposition
- Unmerge from datum group: Detached section keeps current position
- Empty section: Valid to set datum (station still exists)

## Risks

| Risk | Mitigation |
|------|------------|
| Performance with large projects | Only recompute affected connected group |
| GPS conversion accuracy | Use proper ENU projection, not approximation |
| Undo state bloat | Only store affected section offsets |
| Merge/datum interaction complexity | Clear precedence: datum controls offset |

## Test Notes

- Test first datum sets station to (0,0)
- Test second datum on different group uses GPS offset
- Test duplicate datum on same group returns error
- Test undo restores previous positions
- Test merge propagates repositioning
- Test unmerge keeps position
- Test fit-to-bounds called after set

## Acceptance

- [ ] Setting zero datum repositions the station to GPS coordinates (as local coords)
- [ ] First zero datum station becomes local (0,0,z)
- [ ] All transitively connected sections reposition relative to the datum
- [ ] Station coordinates recalculated from shot data using datum as origin
- [ ] Second datum's local position computed from GPS offset relative to first datum
- [ ] Error shown when trying to set datum on already-referenced station group
- [ ] Merge propagates datum repositioning to newly connected sections
- [ ] Unmerge keeps detached section at current position
- [ ] Setting datum is fully undoable (restores previous positions)
- [ ] Removing datum keeps positions, only loses GPS reference
- [ ] Map view fits to bounds after datum is set
- [ ] GPS coordinates validated (-90/90 lat, -180/180 lon)
- [ ] Detailed logging of GPS coords, offsets, and affected stations
- [ ] Z-coordinates (depths) are preserved, not overwritten by GPS depth_reference
- [ ] Unconnected sections maintain position when first datum is set

## References

- Epic spec: `.flow/specs/fn-19-mmx.md`
- Current set_zero_datum: `src-tauri/src/models/project.rs:539-564`
- Section offsets: `src-tauri/src/models/project.rs` (`section_offsets` field)
- Connected groups: `src-tauri/src/models/project.rs:202-222`
- Merge pattern: `src-tauri/src/models/project.rs:333-443`
- Undo data: `src-tauri/src/core/undo.rs:72-77`
- ENU projection: Wikipedia Local_tangent_plane_coordinates
