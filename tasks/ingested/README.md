# CaveChef v1.0 Task Files

This directory contains 30 incremental task specifications for completing CaveChef v1.0.

## Overview

| Phase | Tasks | Description |
|-------|-------|-------------|
| Phase 1 | 1-6 | Import Dialog Enhancements |
| Phase 2 | 7-9 | Map Display Features |
| Phase 3 | 10-14 | GPS & Placement |
| Phase 4 | 15-18 | GlobalView Enhancements |
| Phase 5 | 19-21 | Project Merge |
| Phase 6 | 22-24 | Export & Polish |
| Phase 7 | 25-30 | Testing & Quality |

## Task Dependencies

```
Phase 1 (1-6)  → No dependencies
Phase 2 (7-9)  → No dependencies
Phase 3 (10-14) → Task 14 needed for 12, 13
Phase 4 (15-18) → Task 16 needed for 17, 18
Phase 5 (19-21) → Task 19 → 20 → 21
Phase 6 (22-24) → No dependencies
Phase 7 (25-30) → After features implemented
```

## Risk Assessment

| Risk Level | Tasks |
|------------|-------|
| High | 10, 12, 15, 19, 24, 30 |
| Medium | 1, 3, 5, 6, 8, 9, 11, 13, 14, 17, 18, 20, 21, 22, 26, 28, 29 |
| Low | 2, 4, 7, 16, 23, 25, 27 |

## Task List

### Phase 1: Import Dialog Enhancements
- [task-01-lrud-columns.md](task-01-lrud-columns.md) - Add LRUD columns to DMP Import Dialog
- [task-02-pitch-columns.md](task-02-pitch-columns.md) - Add pitch column to DMP Import Dialog
- [task-03-comment-column.md](task-03-comment-column.md) - Add comment column to DMP Import Dialog
- [task-04-statistics-footer.md](task-04-statistics-footer.md) - Add live statistics footer
- [task-05-validation-warnings.md](task-05-validation-warnings.md) - Add inline validation warnings
- [task-06-section-preview.md](task-06-section-preview.md) - Add section preview

### Phase 2: Map Display Features
- [task-07-scale-bar-toggle.md](task-07-scale-bar-toggle.md) - Wire scale bar toggle
- [task-08-section-name-labels.md](task-08-section-name-labels.md) - Section name labels on map
- [task-09-station-index-labels.md](task-09-station-index-labels.md) - Station index labels on map

### Phase 3: GPS & Placement
- [task-10-gps-coordinates-input.md](task-10-gps-coordinates-input.md) - GPS coordinates input
- [task-11-existing-station-placement.md](task-11-existing-station-placement.md) - From Existing Station option
- [task-12-manual-map-placement.md](task-12-manual-map-placement.md) - Manual map placement mode
- [task-13-section-adjustment-dialog.md](task-13-section-adjustment-dialog.md) - Per-section adjustment dialog
- [task-14-return-section-id.md](task-14-return-section-id.md) - Return section ID from command

### Phase 4: GlobalView Enhancements
- [task-15-direction-field.md](task-15-direction-field.md) - Add direction field to Section
- [task-16-project-metadata-gps.md](task-16-project-metadata-gps.md) - Enrich ProjectMetadata with GPS
- [task-17-globalview-map.md](task-17-globalview-map.md) - GPS-based map in GlobalView
- [task-18-metadata-panel.md](task-18-metadata-panel.md) - Metadata side panel

### Phase 5: Project Merge
- [task-19-merge-projects-command.md](task-19-merge-projects-command.md) - MergeProjects backend command
- [task-20-merge-projects-ipc.md](task-20-merge-projects-ipc.md) - merge_projects IPC handler
- [task-21-merge-ui.md](task-21-merge-ui.md) - Multi-select and merge UI

### Phase 6: Export & Polish
- [task-22-export-preview.md](task-22-export-preview.md) - Export preview thumbnail
- [task-23-grid-overlay.md](task-23-grid-overlay.md) - Wire grid overlay toggle
- [task-24-satellite-imagery-toggle.md](task-24-satellite-imagery-toggle.md) - Satellite imagery toggle

### Phase 7: Testing & Quality
- [task-25-appstate-rust-tests.md](task-25-appstate-rust-tests.md) - Rust tests for AppState
- [task-26-undo-redo-rust-tests.md](task-26-undo-redo-rust-tests.md) - Rust tests for undo/redo
- [task-27-section-model-rust-tests.md](task-27-section-model-rust-tests.md) - Rust tests for Section model
- [task-28-import-dialog-playwright-tests.md](task-28-import-dialog-playwright-tests.md) - Playwright tests for Import Dialog
- [task-29-map-display-playwright-tests.md](task-29-map-display-playwright-tests.md) - Playwright tests for map display
- [task-30-gps-placement-playwright-tests.md](task-30-gps-placement-playwright-tests.md) - Playwright tests for GPS/placement

## Verification Checklist

Before pushing any task:

```bash
# 1. TypeScript type check
pnpm tsc --noEmit

# 2. Playwright E2E tests
pnpm test:ui

# 3. Backend Rust tests
cd src-tauri && cargo test
```

## Key Requirements

- **Timeline**: ASAP (1-2 weeks)
- **Users**: Beta cave divers
- **Testing**: Comprehensive (E2E + Rust + WebdriverIO)
- **Accessibility**: WCAG 2.1 AA
- **i18n**: Full i18n setup
- **GPS Formats**: DD, DMS, DDM, UTM, MGRS, Plus Codes, What3words
