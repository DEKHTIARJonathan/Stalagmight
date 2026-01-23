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
Fixed gps_center coordinate order from (lat,lng) to (lng,lat) for MapLibre compatibility. Updated Rust code, TypeScript type comments, and integration tests.
## Evidence
- Commits: bab96707e8b7a385b067e419dd7d17bb2dbd26cf
- Tests: pnpm tsc --noEmit, cargo test --manifest-path src-tauri/Cargo.toml
- PRs: