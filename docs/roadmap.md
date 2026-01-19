# CaveChef v1.0 Roadmap

The remaining v1.0 features are tracked as PRD files in `prd/` and corresponding Plane projects. Each PRD contains detailed specifications, UI mockups, acceptance criteria, and test cases.

## Phase 1: Import Dialog Enhancements

| Task | PRD | Plane ID | Description |
|------|-----|----------|-------------|
| 01 | 01-lrud-fields.md | LRUD | Add L/R/U/D fields to Import Dialog |
| 02 | 02-pitch-fields.md | PITCH | Add pitch_in/pitch_out fields |
| 03 | 03-comment-field.md | CMNT | Add comment field per shot |
| 04 | 04-section-statistics.md | STAT | Live stats in Import Dialog footer |
| 05 | 05-validation-warnings.md | VALD | Inline validation warnings |

## Phase 2: Map Display Features

| Task | PRD | Plane ID | Description |
|------|-----|----------|-------------|
| 06 | 06-scale-bar.md | SCAL | Wire scale bar toggle to MapLibre |
| 07 | 07-section-names.md | SECN | Section name labels at midpoints |
| 08 | 08-station-labels.md | STAL | Station index labels on map |

## Phase 3: GPS & Placement

| Task | PRD | Plane ID | Description |
|------|-----|----------|-------------|
| 09 | 09-gps-coordinates.md | GPS | GPS input with all format support |
| 10 | 10-per-section-dialog.md | SADJ | Per-section adjustment dialog |
| 11 | 11-manual-placement.md | MPLC | Interactive map placement mode |
| 12 | 12-section-preview.md | SPRV | Live SVG preview in Import Dialog |

## Phase 4: GlobalView Enhancements

| Task | PRD | Plane ID | Description |
|------|-----|----------|-------------|
| 13 | 13-globalview-map.md | GMAP | GPS-based map view with tabs |
| 14 | 14-metadata-panel.md | META | Side panel with project details |
| 15 | 15-multi-select-merge.md | MRGE | Multi-select and merge projects |

## Phase 5: Polish

| Task | PRD | Plane ID | Description |
|------|-----|----------|-------------|
| 16 | 16-direction-field.md | DIRN | IN/OUT direction in DMP import |
| 17 | 17-export-preview.md | EXPV | Export preview thumbnail |

## Backend Changes Required

- `create_section` must return new section ID (Tasks 10-11)
- `ProjectMetadata` needs GPS fields from zero datums (Task 13)
- New `merge_projects` command (Task 15)
- `Section` model needs `direction` field (Task 16)
