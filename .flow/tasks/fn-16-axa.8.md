# fn-16-axa.8 Update SPEC.md documentation for new Settings layout

## Description
Update the project specification document to reflect the new Settings dialog layout, replacing the old tab-based documentation with the new sidebar navigation structure.

**Size:** S
**Depends on:** fn-16-axa.5 (SettingsDialog refactor)
**Files:**
- `docs/SPEC.md` - Update Section 10: Settings Dialog

## Approach

1. Read current SPEC.md Section 10 (Settings Dialog) at lines 1063-1146
2. Rewrite to document new sidebar navigation layout:
   - Section 10.1: Dialog Structure - sidebar + content layout, fixed size
   - Section 10.2: Categories - list all 9 categories with their contents
   - Section 10.3: Navigation - keyboard shortcuts, mouse interaction
   - Section 10.4: Behavior - dirty state, confirmation dialogs, Reset to Defaults
   - Section 10.5: Accessibility - ARIA attributes, keyboard navigation
3. Add Cmd/Ctrl+, to keyboard shortcuts appendix
4. Preserve existing technical accuracy while updating to new layout

## Key Context

- Current SPEC.md Section 10 documents old tab-based layout (Display, Validation, Export, About)
- Must update to reflect 9 new categories: General, Units, Display, Map, Validation, Export, Shortcuts, Cache, Advanced
- Follow existing SPEC.md formatting patterns (numbered sections, tables, bullet lists)

## Acceptance
- [x] Section 10 completely rewritten for sidebar layout
- [x] All 9 categories documented with their contents
- [x] Keyboard navigation documented (Arrow keys, Home/End, Escape)
- [x] Cmd/Ctrl+, shortcut documented
- [x] Dirty state behavior documented
- [x] Reset to Defaults behavior documented
- [x] ARIA accessibility requirements documented
- [x] Existing SPEC.md formatting conventions followed

## Done summary
## Summary

Updated SPEC.md Section 10 (Settings Dialog) to document the new sidebar navigation layout, replacing the old tab-based documentation.

### Changes Made

1. **Section 10.1 Dialog Structure**: Updated to describe modal dialog with sidebar navigation, accessible via Cmd/Ctrl+, shortcut
2. **Section 10.2 Categories**: Documented all 9 categories (General, Units, Display, Map, Validation, Export, Shortcuts, Cache, Advanced) with their contents
3. **Section 10.3 Navigation**: Added keyboard navigation table (Arrow Up/Down, Home, End, Enter/Space, Escape) and mouse interaction details
4. **Section 10.4 Behavior**: Updated to reflect deferred save model, dirty state tracking, validation, and reset to defaults behavior
5. **Section 10.5 Accessibility**: Added ARIA attributes documentation, focus management, and screen reader support details
6. **Section 10.6 Confirmation Dialogs**: Documented both Unsaved Changes and Reset to Defaults confirmation dialogs
7. **Appendix A**: Added Ctrl+, (Cmd+, on macOS) shortcut for Open Settings

### Files Modified
- `docs/SPEC.md` - Complete rewrite of Section 10, added Open Settings to keyboard shortcuts appendix
## Evidence
- Commits:
- Tests:
- PRs: