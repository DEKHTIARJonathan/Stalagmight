# Zero Datum Positioning and Connected Section Repositioning

## Problem

When a zero datum (GPS reference point) is set on a station, the station should be positioned at those exact coordinates on the map, and all sections connected through station merges should move relative to the zero datum station. Currently, setting a zero datum only stores the GPS coordinates but does not reposition the station or connected sections.

## Key Decisions

### Coordinate System
- **First zero datum becomes (0,0)**: The first zero datum set in a project establishes the local coordinate origin
- **Subsequent datums computed relative**: Additional zero datums have their local position computed from GPS offset relative to the first datum
- **Local tangent plane projection**: Convert GPS (lat/lon) to local meters using first datum as projection center
- **Z-coordinate preserved**: Only x/y are computed from GPS; original survey depths are maintained

### Connected Section Behavior
- **All transitively connected sections reposition**: Any section reachable through station merges moves with the datum
- **Recompute from shots**: Station coordinates are recalculated from shot data using the new datum as origin
- **Existing shot-to-coordinate logic**: Reuse the backend's existing calculation that creates sections from shots

### Multi-Datum Rules
- **One datum per connected group**: Cannot set two zero datums on stations in the same connected group
- **Disconnected groups get own datum**: Separate connected groups can each have their own GPS reference
- **Error on duplicate**: Show error message if user tries to set datum on already-referenced group

### Merge/Unmerge Behavior
- **Merge propagates datum**: When sections merge, newly connected sections reposition relative to the datum
- **Unmerge keeps position**: Detached sections stay at their current position

### Unanchored Sections
- **Keep relative position**: Sections not connected to any datum stay at their current position
- **First datum is special**: When first datum is set, existing sections maintain position relative to new (0,0)

### Undo Support
- **Full undo**: Setting a zero datum is undoable, restoring previous positions
- **Remove datum keeps position**: Removing a datum keeps stations where they are, just loses GPS reference

### UI Behavior
- **Fit to bounds after set**: Map view automatically adjusts to show repositioned content
- **Datum marker on station only**: Visual indication only on the zero datum station itself

### Validation
- **Valid GPS coordinates**: Check lat (-90 to 90), lon (-180 to 180)
- **No duplicate in group**: Error if station's connected group already has a datum

### Implementation Scope
- **Backend primarily (Rust)**: Coordinate recalculation happens in Rust
- **Frontend calls command**: Frontend invokes setZeroDatum, backend handles repositioning
- **Logging**: Log GPS coords, computed offsets, and affected stations for debugging

## Edge Cases

- First zero datum set: Becomes (0,0) origin, all existing sections maintain relative positions
- Second zero datum on different group: Computed from GPS offset relative to first datum
- Duplicate datum attempt: Error message "This station group already has a zero datum"
- Remove zero datum: Stations keep current positions, lose GPS reference
- Merge brings section into datum group: Merged section repositions relative to datum
- Unmerge detaches from datum group: Detached section keeps its current position
- GPS coordinates at extreme values: Validate within -90/90 lat, -180/180 lon
- Large GPS offset between datums: Use proper geodesic calculation for accuracy

## Open Questions

- Does the Rust backend already have GPS-to-local coordinate conversion? (needs investigation)
- What is the current shot-to-station coordinate calculation function? (needs investigation)
- How does the backend track connected station groups? (needs investigation)

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
