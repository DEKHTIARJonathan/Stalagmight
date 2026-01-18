# fn-51-ctu.14 Wire Up Context-Aware Dialog Triggering

## Description
Implement context-aware triggering: from home screen (creates new project) vs existing project (adds sections).

## Files to Modify
- `src/components/GlobalView/GlobalView.tsx`
- `src/components/SingleSystemView/SingleSystemView.tsx`
- `src/hooks/useKeyboardShortcuts.ts`
- `src/store/uiStore.ts`
- `src/App.tsx`

## Flows
**From Home Screen (no project)**:
1. Ctrl+I or Import button
2. Open file picker, parse DMP
3. Show NewProjectDialog
4. On project created, open DmpSelectionDialog

**From Existing Project**:
1. Ctrl+I or Import button
2. Open file picker, parse DMP
3. Check for duplicate import (file hash)
4. Open DmpSelectionDialog directly

**Drag and Drop**:
- Same logic based on whether project is open

## References
- `tasks/urgent/task-14-context-aware-dialog-triggering.md`
## Acceptance
- [ ] Ctrl+I from home screen prompts for project name
- [ ] Ctrl+I from existing project opens Step 1 directly
- [ ] Duplicate file check warns user
- [ ] Drag-drop DMP file triggers same flow
- [ ] Drag-drop from home screen creates project
- [ ] Drag-drop to existing project adds sections
- [ ] TypeScript compiles without errors
## Done summary
## Summary
Implemented context-aware DMP import dialog triggering with:

1. **Ctrl+I from home screen** - Opens NewProjectForImportDialog to prompt for project name, then proceeds to DmpSelectionDialog
2. **Ctrl+I from existing project** - Opens DmpSelectionDialog (Step 1) directly with parsed DMP data
3. **Duplicate file detection** - Session-based tracking of imported file paths; shows DuplicateImportDialog warning when re-importing the same file
4. **Drag-drop support** - Same context-aware flow for drag-drop DMP files

### Changes
- `src/store/uiStore.ts`: Added `importedDmpPaths` Set and methods for tracking/checking imported files
- `src/hooks/useKeyboardShortcuts.ts`: Updated Ctrl+I handler with duplicate detection and proper context routing
- `src/App.tsx`: Updated drag-drop handler with duplicate detection
- `src/components/Dialogs/DuplicateImportDialog.tsx`: New dialog for duplicate import warning
- `src/components/Dialogs/index.ts`: Export DuplicateImportDialog
- `e2e-playwright/dmp-import.spec.ts`: Added test for duplicate import warning, updated cancel test

### Acceptance Criteria
- [x] Ctrl+I from home screen prompts for project name
- [x] Ctrl+I from existing project opens Step 1 directly
- [x] Duplicate file check warns user
- [x] Drag-drop DMP file triggers same flow
- [x] Drag-drop from home screen creates project
- [x] Drag-drop to existing project adds sections
- [x] TypeScript compiles without errors
## Evidence
- Commits:
- Tests: playwright, typescript, rust
- PRs: