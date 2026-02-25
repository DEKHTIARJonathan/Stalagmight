# Stalagmight v1.0 Roadmap

The v1.0 features are tracked as PRD files in `prd/` and corresponding Plane projects. Each PRD contains detailed specifications, UI mockups, acceptance criteria, and test cases.

**Status**: All planned features are implemented.

## Phase 1: Import Dialog Enhancements

| Task | PRD | Plane ID | Status | Description |
|------|-----|----------|--------|-------------|
| 01 | 01-lrud-fields.md | LRUD | Done | Add L/R/U/D fields to Import Dialog |
| 02 | 02-pitch-fields.md | PITCH | Done | Add pitch_in/pitch_out fields |
| 03 | 03-comment-field.md | CMNT | Done | Add comment field per shot |
| 04 | 04-section-statistics.md | STAT | Done | Live stats in Import Dialog footer |
| 05 | 05-validation-warnings.md | VALD | Done | Inline validation warnings |

## Phase 2: Map Display Features

| Task | PRD | Plane ID | Status | Description |
|------|-----|----------|--------|-------------|
| 06 | 06-scale-bar.md | SCAL | Done | Wire scale bar toggle to MapLibre |
| 07 | 07-section-names.md | SECN | Done | Section name labels at midpoints |
| 08 | 08-station-labels.md | STAL | Done | Station index labels on map |

## Phase 3: GPS & Placement

| Task | PRD | Plane ID | Status | Description |
|------|-----|----------|--------|-------------|
| 09 | 09-gps-coordinates.md | GPS | Done | GPS input with all format support |
| 10 | 10-per-section-dialog.md | SADJ | Done | Per-section adjustment dialog |
| 11 | 11-manual-placement.md | MPLC | Done | Interactive map placement mode |
| 12 | 12-section-preview.md | SPRV | Done | Live SVG preview in Import Dialog |

## Phase 4: GlobalView Enhancements

| Task | PRD | Plane ID | Status | Description |
|------|-----|----------|--------|-------------|
| 13 | 13-globalview-map.md | GMAP | Done | GPS-based map view with tabs |
| 14 | 14-metadata-panel.md | META | Done | Side panel with project details |
| 15 | 15-multi-select-merge.md | MRGE | Done | Multi-select and merge projects |

## Phase 5: Polish

| Task | PRD | Plane ID | Status | Description |
|------|-----|----------|--------|-------------|
| 16 | 16-direction-field.md | DIRN | Done | IN/OUT direction in DMP import |
| 17 | 17-export-preview.md | EXPV | Done | Export preview thumbnail |

## Post-Roadmap Features

These features were implemented after the original roadmap was completed:

| Feature | Description |
|---------|-------------|
| Color Themes | 9 color themes (dark, light, cave, dracula, one_dark, solarized_light, catppuccin_latte, nord, catppuccin_mocha) with independent day/night palettes |
| Keyboard Shortcuts Overlay | `?` key opens a filterable shortcuts reference dialog |
| Grid Overlay | Theme-aware coordinate grid with auto-spacing (1–100m) |
| Placement Suggestion Tuning | Heuristic constants exposed in Advanced Settings |

## Backend Changes Required

All backend changes have been implemented:

- `create_section` returns new section ID via `CommandResult.section_id`
- `ProjectMetadata` has `gps_center` and `gps_bounds` fields
- `merge_projects` command implemented in `commands/project.rs`
- `Section` model has `direction: SurveyDirection` field
