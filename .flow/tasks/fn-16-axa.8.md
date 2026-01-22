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
- [ ] Section 10 completely rewritten for sidebar layout
- [ ] All 9 categories documented with their contents
- [ ] Keyboard navigation documented (Arrow keys, Home/End, Escape)
- [ ] Cmd/Ctrl+, shortcut documented
- [ ] Dirty state behavior documented
- [ ] Reset to Defaults behavior documented
- [ ] ARIA accessibility requirements documented
- [ ] Existing SPEC.md formatting conventions followed
