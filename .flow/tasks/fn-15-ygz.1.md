# fn-15-ygz.1 Add Tauri command for survey geometry

## Description

Add new Tauri command `get_survey_geometry` that returns lightweight GPS-transformed survey data for rendering in the global view.

**Size:** M
**Files:**
- `src-tauri/src/commands/mod.rs` (add command export)
- `src-tauri/src/commands/survey_geometry.rs` (new file)
- `src/types/survey.ts` (add TypeScript types)

## Approach

- Follow command pattern at `src-tauri/src/commands/project.rs:load_project`
- Implement `meters_to_map_coords` with latitude-adjusted formula matching frontend:
  ```rust
  let meters_per_degree_lat = 111320.0;
  let meters_per_degree_lng = 111320.0 * origin_lat.to_radians().cos();
  let lng = origin_lng + (x / meters_per_degree_lng);
  let lat = origin_lat + (y / meters_per_degree_lat);
  ```
- Return SurveyGeometry: file_path, name, total_length, station_count, gps_origin, shots, stations, is_virtual
- Reject projects without GPS (gps_center == null)

## Acceptance

- [ ] New Tauri command `get_survey_geometry` registered
- [ ] Returns SurveyGeometry with GPS-transformed coordinates
- [ ] Includes metadata: file_path, name, total_length, station_count
- [ ] Uses latitude-adjusted coordinate transform matching frontend
- [ ] Unit tests compare Rust transform against known frontend values
- [ ] Returns error for projects without GPS
- [ ] TypeScript types added

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
