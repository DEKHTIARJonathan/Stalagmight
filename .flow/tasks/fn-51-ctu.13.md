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
# Task fn-51-ctu.13: Implement Navigation and Import Buttons

## Summary
Implemented the Import button validation logic for the DmpSectionConfigDialog to disable the import when:
1. Not all sections are placed
2. Any section has errors (e.g., no valid shots)

## Changes Made

### src/components/Dialogs/DmpSectionConfigDialog.tsx
- Added `notPlacedCount` useMemo to count sections that haven't been placed yet
- Added `canImport` computed variable that is true only when `errorCount === 0 && notPlacedCount === 0`
- Updated Import button to be disabled when `isLastSection && !canImport`
- Added tooltip on disabled Import button explaining why it's disabled
- Updated keyboard shortcut handler (Ctrl+Enter) to respect the `canImport` validation
- Reordered variable definitions to ensure proper dependency order for useEffect

## Acceptance Criteria Status
- [x] Previous button navigates to previous section (already implemented)
- [x] Previous disabled on first section (already implemented)
- [x] Next button navigates to next section (already implemented)
- [x] Next changes to "Import X Sections" on last section (already implemented)
- [x] Import button disabled if not all placed (NEW - implemented)
- [x] Import button disabled if errors exist (NEW - implemented)
- [x] Back to Selection confirms and undoes placements (already implemented)
- [x] Cancel confirms and removes placed sections (already implemented)
- [x] Ctrl+Enter triggers Next/Import (already implemented, updated to respect canImport)
- [x] Ctrl+Arrow navigates between sections (already implemented)
- [x] TypeScript compiles without errors (verified)

## Testing
- TypeScript: Compiles without errors
- Playwright: 225/226 tests pass (1 unrelated failure in globalview-map.spec.ts)
- Rust backend: 72/72 tests pass
## Evidence
- Commits:
- Tests: typescript, playwright, rust
- PRs: