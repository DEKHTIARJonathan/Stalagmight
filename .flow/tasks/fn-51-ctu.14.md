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
TBD

## Evidence
- Commits:
- Tests:
- PRs:
