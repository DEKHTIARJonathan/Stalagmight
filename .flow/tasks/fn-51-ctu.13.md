# fn-51-ctu.13 Implement Navigation and Import Buttons

## Description
Implement Previous/Next navigation, Import button, and Back to Selection with confirmations.

## Files to Modify
- `src/components/Dialogs/DmpSectionConfigDialog.tsx`

## Button Behaviors
- **Previous**: Go to previous section (disabled on first), auto-save current
- **Next**: Go to next section, changes to "Import X Sections" on last
- **Import**: Disabled if not all placed or errors exist; closes dialog, switches view
- **Back to Selection**: Confirms, deletes all placed sections, returns to Step 1
- **Cancel**: Confirms, deletes all placed sections, closes dialog

## Keyboard Shortcuts
- Ctrl+Enter: proceed (Next or Import)
- Ctrl+Arrow Left/Right: Previous/Next section

## References
- `tasks/urgent/task-13-navigation-and-import-buttons.md`
## Acceptance
- [ ] Previous button navigates to previous section
- [ ] Previous disabled on first section
- [ ] Next button navigates to next section
- [ ] Next changes to "Import X Sections" on last section
- [ ] Import button disabled if not all placed
- [ ] Import button disabled if errors exist
- [ ] Back to Selection confirms and undoes placements
- [ ] Cancel confirms and removes placed sections
- [ ] Ctrl+Enter triggers Next/Import
- [ ] Ctrl+Arrow navigates between sections
- [ ] TypeScript compiles without errors
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
