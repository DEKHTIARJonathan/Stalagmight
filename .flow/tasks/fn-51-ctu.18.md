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
TBD

## Evidence
- Commits:
- Tests:
- PRs:
