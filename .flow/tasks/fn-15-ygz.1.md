# fn-15-ygz.1 Add Tauri command for survey geometry

## Description
Add a new Tauri command `get_survey_geometry` that returns lightweight GPS-transformed survey data for rendering in the global view. This command loads a project file and extracts only the geometry needed for visualization.

**Size:** M
**Files:** 
- `src-tauri/src/commands/mod.rs` (add command export)
- `src-tauri/src/commands/survey_geometry.rs` (new file)
- `src/types/survey.ts` (add TypeScript types)

## Approach

- Follow command pattern at `src-tauri/src/commands/project.rs:load_project`
- Transform coordinates using GPS origin like `metersToMapCoords()` does in frontend
- Return minimal data: file_path, gps_origin, shots (as coordinate pairs), stations (as points), is_virtual flags
- Handle errors gracefully: return Result with descriptive error messages

## Key context

- Backend uses `serde` for serialization - match existing patterns
- GPS transformation: multiply local meters by scale factor, add to origin lat/lng
- Virtual shots have `is_virtual: true` in Shot struct
## Acceptance
- [ ] New Tauri command `get_survey_geometry` registered and callable from frontend
- [ ] Returns `SurveyGeometry` struct with GPS-transformed coordinates
- [ ] Filters out corrupted/invalid geometry (NaN, Infinity values)
- [ ] Returns proper error for missing/corrupted files
- [ ] TypeScript types added for frontend consumption
- [ ] Rust tests pass for valid and invalid project files
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
