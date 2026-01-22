# fn-19-mmx.7 Update documentation for zero datum behavior

## Description
Update project documentation to describe zero datum positioning behavior, coordinate transformation, and GPS-to-local conversion.

**Size:** S
**Files:** `docs/SPEC.md`, `docs/architecture.md`

## Approach

1. Update SPEC.md Section 8 (Commands) with SetZeroDatum parameter documentation
2. Update SPEC.md Section 5 (Architecture) with coordinate transformation details
3. Add zero datum workflow description to Section 6 (UI Workflows)
4. Update architecture.md with coordinate transform reference

Follow existing documentation patterns in SPEC.md.

## Key context

<!-- Updated by plan-sync: fn-19-mmx.1 implemented geo module at src-tauri/src/models/geo.rs -->
GPS-to-local conversion implemented in `src-tauri/src/models/geo.rs` with:
- `geodetic_to_ecef(lat, lon, alt)` - public
- `ecef_to_enu(dx, dy, dz, lat0, lon0)` - private helper
- `gps_to_local(gps, origin)` - public, main entry point

Docs gap analysis identified: Command parameter docs, coordinate transformation algorithm, user workflow steps, undo behavior documentation all need updates.
## Acceptance
- [ ] SPEC.md Section 8 documents SetZeroDatum parameters and undo behavior
- [ ] SPEC.md Section 5 documents GPS-to-local coordinate transformation
- [ ] SPEC.md Section 6 includes zero datum workflow steps
- [ ] architecture.md references coordinate transform location
- [ ] Documentation follows existing format patterns
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
