# DMP Import Refactoring - Two-Step Flow

## Overview

This task set refactors the DMP import workflow from a single dialog to a two-step process:

1. **Step 1 (Selection)**: User selects which sections to import, sets default surveyor/date
2. **Step 2 (Configuration)**: Per-section editing with placement options, shot table, and preview

## Task Summary

| # | Task | Description | Dependencies |
|---|------|-------------|--------------|
| 01 | [Shared ShotTableEditor](task-01-shared-shot-table-editor.md) | Extract shot table into reusable component | - |
| 02 | [Shared SectionMetadataForm](task-02-shared-section-metadata-form.md) | Extract metadata form into reusable component | - |
| 03 | [Enhanced SectionPreview](task-03-enhanced-section-preview.md) | Add pan/zoom/click to preview | - |
| 04 | [DmpSelectionDialog Shell](task-04-dmp-selection-dialog-shell.md) | Create Step 1 dialog | - |
| 05 | [DmpSectionConfigDialog Shell](task-05-dmp-section-config-dialog-shell.md) | Create Step 2 dialog shell | 01, 02, 03 |
| 06 | [Section Parameters Panel](task-06-section-parameters-panel.md) | Add parameters panel to Step 2 | 02, 05 |
| 07 | [Placement Options Panel](task-07-placement-options-panel.md) | Add placement options to Step 2 | 05 |
| 08 | [Shot Table Integration](task-08-shot-table-integration.md) | Integrate ShotTableEditor in Step 2 | 01, 05 |
| 09 | [Merge Preview Visualization](task-09-merge-preview-visualization.md) | Preview merge positions | 03, 07 |
| 10 | [Manual Placement Mode](task-10-manual-placement-mode.md) | Implement map placement | 07 |
| 11 | [Import State Management](task-11-import-state-management.md) | Undo/redo and state tracking | 05 |
| 12 | [Section Creation Logic](task-12-section-creation-logic.md) | Backend calls for placement | 07, 11 |
| 13 | [Navigation & Import Buttons](task-13-navigation-and-import-buttons.md) | Previous/Next/Import logic | 05, 11 |
| 14 | [Context-Aware Triggering](task-14-context-aware-dialog-triggering.md) | Home vs project context | 04, 05 |
| 15 | [File Hash Tracking](task-15-file-hash-tracking.md) | Detect duplicate imports | - |
| 16 | [Session Surveyor Memory](task-16-session-surveyor-memory.md) | Remember surveyor in session | 04 |
| 17 | [Validation Thresholds](task-17-validation-thresholds.md) | Configurable azi/pitch thresholds | 01 |
| 18 | [Error Blocking Logic](task-18-error-blocking-logic.md) | Block import on errors | 13 |
| 19 | [Update Edit Section Dialog](task-19-update-edit-section-dialog.md) | Use shared components | 01, 02 |
| 20 | [Remove Old Dialog](task-20-remove-old-dmp-import-dialog.md) | Clean up old code | All above |
| 21 | [App Close Confirmation](task-21-app-close-confirmation.md) | Confirm on window close | 11 |
| 22 | [Update Existing Tests](task-22-update-existing-tests.md) | Update test suite | 20 |

## Dependency Graph

```
Phase 1: Shared Components (parallel)
├── 01-shared-shot-table-editor
├── 02-shared-section-metadata-form
├── 03-enhanced-section-preview
├── 15-file-hash-tracking
└── 17-validation-thresholds

Phase 2: Dialog Shells
├── 04-dmp-selection-dialog-shell
│   └── 16-session-surveyor-memory
└── 05-dmp-section-config-dialog-shell (depends on 01, 02, 03)
    ├── 06-section-parameters-panel (depends on 02)
    ├── 07-placement-options-panel
    │   ├── 09-merge-preview-visualization (depends on 03)
    │   └── 10-manual-placement-mode
    ├── 08-shot-table-integration (depends on 01)
    └── 11-import-state-management
        ├── 12-section-creation-logic (depends on 07)
        ├── 13-navigation-and-import-buttons
        │   └── 18-error-blocking-logic
        └── 21-app-close-confirmation

Phase 3: Integration
├── 14-context-aware-dialog-triggering (depends on 04, 05)
├── 19-update-edit-section-dialog (depends on 01, 02)
└── 20-remove-old-dmp-import-dialog (depends on all)

Phase 4: Testing
└── 22-update-existing-tests (depends on 20)
```

## Recommended Implementation Order

1. **Week 1: Foundation**
   - Task 01: ShotTableEditor (shared component)
   - Task 02: SectionMetadataForm (shared component)
   - Task 03: Enhanced SectionPreview
   - Task 15: File hash tracking (backend)
   - Task 17: Validation thresholds

2. **Week 2: Step 1 Dialog**
   - Task 04: DmpSelectionDialog shell
   - Task 16: Session surveyor memory

3. **Week 3: Step 2 Dialog Shell**
   - Task 05: DmpSectionConfigDialog shell
   - Task 06: Section parameters panel
   - Task 08: Shot table integration
   - Task 11: Import state management

4. **Week 4: Placement**
   - Task 07: Placement options panel
   - Task 09: Merge preview visualization
   - Task 10: Manual placement mode
   - Task 12: Section creation logic

5. **Week 5: Navigation & Polish**
   - Task 13: Navigation and import buttons
   - Task 18: Error blocking logic
   - Task 21: App close confirmation
   - Task 14: Context-aware triggering

6. **Week 6: Cleanup**
   - Task 19: Update Edit Section dialog
   - Task 20: Remove old dialog
   - Task 22: Update existing tests

## Key Design Decisions

- **Sections created on placement**: Each section is created in backend when user clicks "Place"
- **Granular undo**: Each edit after placement creates a separate undo entry
- **Exclusive placement modes**: Only one placement method per section
- **No warnings acknowledgement**: Warnings shown but don't block, only errors block
- **Session-only surveyor memory**: Not persisted to config
- **Azimuth as average**: Single column shows average, editing sets both in/out

## Testing Requirements

Each task includes:
- 3-10 Rust unit tests (where applicable)
- 3-10 Playwright E2E tests
- 3-10 WebdriverIO E2E tests

Run before push:
```bash
pnpm tsc --noEmit
pnpm test:ui
cd src-tauri && cargo test
```
