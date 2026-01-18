# fn-51-ctu.18 Implement Error Blocking Logic

## Description
Implement error detection and blocking for Import button. Errors block import, not navigation.

## Files to Modify
- `src/components/Dialogs/DmpSectionConfigDialog.tsx`
- `src/utils/validation.ts`

## Error Types
- **invalidData**: Zero/negative length, invalid azimuth (outside 0-360)
- **missingPlacement**: Section not placed
- **mergeConflict**: Target section for merge doesn't exist

## Import Button State
- Disabled when any error exists or not all sections placed
- Tooltip shows error count
- Previous/Next still work with errors

## Left Panel Display
- Error count badge per section with errors

## References
- `tasks/urgent/task-18-error-blocking-logic.md`
## Acceptance
- [ ] Invalid data errors detected (negative length, bad azimuth)
- [ ] Missing placement error detected
- [ ] Merge conflict error detected (target doesn't exist)
- [ ] Import button disabled when errors exist
- [ ] Import button shows error count in tooltip
- [ ] Left panel shows error count per section
- [ ] Navigation still works with errors
- [ ] TypeScript compiles without errors
## Done summary
## Summary
Implemented error blocking logic for the Import Dialog (Step 2 - DmpSectionConfigDialog):

### Changes Made
1. **src/utils/validation.ts**: Added import-specific error types and validation functions:
   - `ImportError` interface with types: `invalidData`, `missingPlacement`, `mergeConflict`
   - `validateEditableShot()` - validates shot data (length > 0, azimuth in [0,360))
   - `validatePlacement()` - checks if section is placed
   - `validateMergeTarget()` - validates merge target exists for fromExisting placement

2. **src/hooks/useImportState.ts**: Added error computation functions:
   - `getSectionErrors()` - returns all errors for a section
   - `getAllSectionErrors()` - returns errors for all sections
   - `getSectionErrorCount()` - counts errors per section
   - `getTotalErrorCount()` - total errors across all sections
   - `canImport()` - checks if import is allowed
   - Updated `getSectionStatus()` to detect shot validation errors

3. **src/components/Dialogs/DmpSectionConfigDialog.tsx**:
   - Import button disabled when any errors exist
   - Import button tooltip shows error count
   - Left panel shows error count badge per section with errors
   - Error summary at bottom of left panel
   - Navigation (Previous/Next) still works with errors

### Acceptance Criteria Met
- [x] Invalid data errors detected (negative length, bad azimuth)
- [x] Missing placement error detected
- [x] Merge conflict error detected (target doesn't exist)
- [x] Import button disabled when errors exist
- [x] Import button shows error count in tooltip
- [x] Left panel shows error count per section
- [x] Navigation still works with errors
- [x] TypeScript compiles without errors

### Tests Added
6 new Playwright tests in `e2e-playwright/dmp-import.spec.ts`:
1. `should show error count badges in section list`
2. `should disable Import button when section has errors`
3. `should allow navigation between sections with errors`
4. `should show error summary in left panel`
5. `should enable Import after fixing errors`
6. `should show error icon in section list for invalid data`
## Evidence
- Commits:
- Tests: e2e-playwright/dmp-import.spec.ts: 6 new tests for Step 2 error blocking, pnpm test:ui - 118 passed (1 skipped), pnpm tsc --noEmit - passes, cargo test - 72 passed
- PRs: