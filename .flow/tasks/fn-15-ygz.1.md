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

Implemented async Tauri command `get_survey_geometry` that returns GPS-transformed survey data for map display.

### Changes
- **src-tauri/src/commands/survey_geometry.rs** (new): Core command implementation
  - `GeometryShot` struct with `from`, `to` ([lng, lat]), `is_virtual`, `section_id`
  - `SurveyGeometry` response with `shots` array and `origin`
  - `local_to_gps()` function with error handling for extreme latitudes (±89.4°)
  - Computes coordinates relative to zero-datum station `(x0, y0)`
  - Returns error (not silent skip) for missing stations
  - `get_survey_geometry` async command using `spawn_blocking`
  - 7 unit tests for coordinate transforms

- **src-tauri/src/commands/mod.rs**: Added `pub mod survey_geometry`
- **src-tauri/src/lib.rs**: Registered command in `generate_handler![]`

- **src/types/survey.ts** (new): TypeScript types
  - `GeometryShot`, `SurveyGeometry`, `SurveyGeometryError` interfaces
  - `metersToMapCoords()` function (not exported from barrel to avoid collision)

- **src/types/index.ts**: Exports types only (not utility function)

- **tests/fixtures/coordinate_transform_vectors.json** (new): Shared test vectors
- **src/types/__tests__/survey.test.ts** (new): 12 TypeScript tests (loads fixture)

### Algorithm
Coordinates computed relative to zero-datum station using linear approximation:
- Find zero-datum station `(x0, y0)`, compute `east = x - x0`, `north = y - y0`
- `lat = origin_lat + (north / 111320)`
- `lng = origin_lng + (east / (111320 * cos(origin_lat_rad)))`

Returns error if project has no GPS reference (zero datum) or latitude is too extreme.

## Evidence
- Commits: fa7b60f
- Tests: Rust (7 passed), TypeScript (12 passed)
- Review: SHIP verdict from codex impl-review