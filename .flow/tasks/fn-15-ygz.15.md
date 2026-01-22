# fn-15-ygz.15 Fix gps_center coordinate order (lat,lng -> lng,lat)

## Description
Fix the coordinate order mismatch in `gps_center`. Currently Rust stores `(latitude, longitude)` but frontend expects `[lng, lat]` for MapLibre compatibility.

**Size:** S
**Files:**
- `src-tauri/src/models/project.rs` (fix gps_center storage order)
- `src/components/GlobalView/GlobalViewMap.tsx` (verify correct usage)
- `src/types/project.ts` (update type comments)

## Approach

- Change Rust `gps_center` from `Some((first_gps.latitude, first_gps.longitude))` to `Some((first_gps.longitude, first_gps.latitude))`
- Update any Rust code that reads gps_center to expect `(lng, lat)` order
- Verify frontend code already expects `[lng, lat]` (it does)
- Update type comments in both Rust and TypeScript
## Acceptance
- [ ] Rust gps_center stores (longitude, latitude) order
- [ ] Frontend correctly interprets as [lng, lat]
- [ ] Existing global view map still renders correctly
- [ ] Type comments updated in both languages
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
