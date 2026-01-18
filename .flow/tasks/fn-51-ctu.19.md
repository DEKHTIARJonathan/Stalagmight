# fn-51-ctu.19 Update EditSectionDialog to Use Shared Components

## Description
Refactor EditSectionDialog to use new shared components (ShotTableEditor, SectionMetadataForm).

## Files to Modify
- `src/components/Dialogs/EditSectionDialog.tsx`

## Changes
- Replace inline metadata form with SectionMetadataForm
- Replace inline shot table with ShotTableEditor
- Add direction field (dropdown: "In" / "Out")
- Add insert before/after handlers
- Match new column layout (Azimuth as average, Warnings column)

## References
- `tasks/urgent/task-19-update-edit-section-dialog.md`
- `e2e-playwright/section-shot-editing.spec.ts` (primary test file to update)
## Acceptance
- [ ] EditSectionDialog uses SectionMetadataForm
- [ ] EditSectionDialog uses ShotTableEditor
- [ ] New column layout matches import dialog
- [ ] Azimuth edits set both in/out values
- [ ] Warnings column shows azimuth/pitch discrepancies
- [ ] Insert before/after works via context menu
- [ ] Direction field editable
- [ ] All existing functionality preserved
- [ ] TypeScript compiles without errors
- [ ] Existing tests pass
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
