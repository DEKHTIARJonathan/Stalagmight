# fn-51-ctu.20 Remove Old DmpImportDialog

## Description
Remove old DmpImportDialog and update all references to use new two-step flow.

## Files to Delete
- `src/components/Dialogs/DmpImportDialog.tsx`

## Files to Modify
- `src/components/Dialogs/index.ts`
- `src/App.tsx`
- `src/store/uiStore.ts`
- `src/hooks/useKeyboardShortcuts.ts`

## Utility Functions to Preserve
Move to `src/utils/dmpUtils.ts` if not already extracted:
- normalizeDmpValue
- formatPitch
- calculateStats

## Test Updates Required
- All tests using `[data-testid="import-dmp-dialog"]` need updating
- Major rewrites for `e2e-playwright/import-dialog.spec.ts` and `e2e-playwright/dmp-import.spec.ts`

## References
- `tasks/urgent/task-20-remove-old-dmp-import-dialog.md`
## Acceptance
- [ ] Old DmpImportDialog.tsx deleted
- [ ] Dialog exports updated
- [ ] App.tsx no longer references old dialog
- [ ] UI store cleaned up
- [ ] Keyboard shortcuts use new flow
- [ ] Utility functions preserved if needed
- [ ] Playwright tests updated for new flow
- [ ] No TypeScript errors
- [ ] All tests pass with new dialog flow
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
