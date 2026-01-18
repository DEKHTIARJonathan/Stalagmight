# DMP Import Refactoring - Two-Step Flow

## Overview

Refactor the DMP import workflow from a single monolithic dialog (`DmpImportDialog.tsx`, ~1287 lines) into a two-step process that improves UX for importing cave survey data.

**Step 1 (DmpSelectionDialog)**: User selects which sections to import, sets default surveyor and date that apply to all sections.

**Step 2 (DmpSectionConfigDialog)**: Per-section editing with placement options, shot table editing, and live preview. Sections are created in the backend when placed.

## Scope

### In Scope
- Extract shared components (ShotTableEditor, SectionMetadataForm)
- Create Step 1 dialog for section selection
- Create Step 2 dialog with per-section configuration
- 4 placement modes: Origin (0,0), Zero Datum (GPS), From Existing (merge), Manual (map click)
- Import state management with undo/redo
- File hash tracking for duplicate detection
- Session surveyor memory
- Configurable validation thresholds
- Update existing EditSectionDialog to use shared components
- Update all E2E tests for new flow

### Out of Scope
- Mobile/responsive layout (desktop only)
- Internationalization (English only for now)
- Offline tile caching for map
- Loop closure error distribution

## Approach

### Phase 1: Shared Components (Tasks 01-03, 15, 17) - Parallel
Extract reusable components from existing code:
- `ShotTableEditor`: Azimuth as average column, warnings column, context menu
- `SectionMetadataForm`: Name, surveyor, date, color, direction fields
- Enhanced `SectionPreview`: Pan/zoom/click-to-select-station
- File hash tracking backend
- Validation thresholds config

### Phase 2: Dialog Shells (Tasks 04-05, 16) - Sequential
Create the two new dialog components with their basic structure.

### Phase 3: Step 2 Panels (Tasks 06-08, 11) - Parallel
Add panels to Step 2: parameters, placement options, shot table, state management.

### Phase 4: Placement Features (Tasks 07, 09-10, 12) - Sequential
Implement all four placement modes with preview visualization.

### Phase 5: Navigation & Integration (Tasks 13-14, 18, 21) - Sequential
Wire up navigation buttons, context-aware triggering, error blocking.

### Phase 6: Cleanup (Tasks 19-20, 22)
Update EditSectionDialog, remove old dialog, update tests.

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Sections created on placement | Enables granular undo, immediate persistence |
| Exclusive placement modes | Simpler UX, clearer mental model |
| Warnings don't block, errors block | Warnings inform, don't impede workflow |
| Session-only surveyor memory | Respects privacy, not persisted to config |
| Azimuth as average | Single column shows average, edit sets both in/out |

## Quick Commands

```bash
# TypeScript type check
pnpm tsc --noEmit

# Run Playwright tests (mocked IPC)
pnpm test:ui

# Run Rust backend tests
cd src-tauri && cargo test

# Full test suite
pnpm test:all
```

## Acceptance

- [ ] Two-step import flow works end-to-end
- [ ] All 4 placement modes functional
- [ ] Shared components work in both DmpSectionConfigDialog and EditSectionDialog
- [ ] Undo/redo works within import dialog
- [ ] File hash tracking warns on duplicate imports
- [ ] Session surveyor memory works across imports
- [ ] All existing Playwright tests updated and passing
- [ ] All existing WebdriverIO tests updated and passing
- [ ] TypeScript compiles without errors
- [ ] No regressions in existing functionality

## References

### Key Files
- `src/components/Dialogs/DmpImportDialog.tsx` (to be refactored)
- `src/components/Dialogs/EditSectionDialog.tsx` (uses shared components)
- `src/components/Dialogs/DialogWrapper.tsx` (reuse)
- `src/components/Dialogs/SectionPreview.tsx` (enhance)
- `src/store/uiStore.ts` (dialog state)
- `src/utils/validation.ts` (reuse)

### PRDs
- `prd/10-per-section-dialog.md`
- `prd/12-section-preview.md`

### Task Specs
- `tasks/urgent/README.md` (full dependency graph)
- `tasks/urgent/task-01-*.md` through `task-22-*.md`
