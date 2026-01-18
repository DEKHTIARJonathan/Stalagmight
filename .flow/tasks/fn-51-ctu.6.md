# fn-51-ctu.6 Add Section Parameters Panel to Step 2

## Description
Add section parameters editing panel to DmpSectionConfigDialog using SectionMetadataForm.

## Files to Modify
- `src/components/Dialogs/DmpSectionConfigDialog.tsx`

## Panel Layout
Located top-right of main panel, next to preview:
- Name, Direction dropdown
- Surveyor, Date, Color picker
- Reset Section button

## Behavior
- Pre-filled from Step 1 defaults and DMP data
- Auto-save on navigation
- Reset button restores original DMP values and clears placement

## References
- `tasks/urgent/task-06-section-parameters-panel.md`
## Acceptance
- [ ] Section parameters panel renders in correct position
- [ ] All fields editable: name, direction, surveyor, date, color
- [ ] Values pre-filled from Step 1 and DMP
- [ ] Reset Section button resets all fields and placement
- [ ] Auto-save on navigation works
- [ ] Color picker works with hex input
- [ ] TypeScript compiles without errors
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
