# fn-15-ygz.1 Add Tauri command for survey geometry

## Description

Add new async Tauri command `get_survey_geometry` that returns GPS-transformed survey data.

**Size:** M
**Files:**
- `src-tauri/src/commands/survey_geometry.rs` (new file)
- `src-tauri/src/commands/mod.rs` (add `pub mod survey_geometry;`)
- `src-tauri/src/lib.rs` (add to `generate_handler![]` list)
- `src/types/survey.ts` (add TypeScript types)
- `src/types/index.ts` (export new types)
- `tests/fixtures/coordinate_transform_vectors.json` (test vectors)

## Approach

1. Create async command using `tauri::async_runtime::spawn_blocking` to avoid UI blocking
2. Compute coordinates relative to zero-datum station:
   - Find zero-datum station, get its raw coords `(x0, y0)`
   - For each station `(x, y)`: `dx = x - x0`, `dy = y - y0`
   - Transform: `lng = origin_lng + dx/meters_per_degree_lng`, `lat = origin_lat + dy/meters_per_degree_lat`
   - `meters_per_degree_lng = 111320.0 * cos(origin_lat_rad)`
3. Return self-contained Shot struct (not parallel arrays):
   ```rust
   struct Shot { from: [f64; 2], to: [f64; 2], is_virtual: bool }
   ```
4. Register in `generate_handler![]` in lib.rs
5. Create test vectors JSON, test in both Rust and TS

## Acceptance

- [ ] Async Tauri command `get_survey_geometry` registered and callable
- [ ] Returns SurveyGeometry with GPS-transformed coordinates
- [ ] Coordinates computed relative to zero-datum station
- [ ] Shot struct is self-contained (includes is_virtual per shot)
- [ ] Returns error for projects without GPS
- [ ] TypeScript types added and exported
- [ ] Test vectors verify Rust transform matches expected values
- [ ] Test vectors verify TS `metersToMapCoords` matches expected values
- [ ] Command registered in lib.rs generate_handler!

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
