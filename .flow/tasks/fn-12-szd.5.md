# fn-12-szd.5 Add Ctrl+G keyboard shortcut

## Description
Add Ctrl+G keyboard shortcut to focus the currently selected section on the map.

**Size:** S
**Files:** `src/hooks/useKeyboardShortcuts.ts`

## Approach

- Follow existing Ctrl+0 pattern at `src/hooks/useKeyboardShortcuts.ts:131-134`
- Add case for `g` key with Ctrl modifier
- Check if current selection is a section (`selection?.type === 'section'`)
- If section selected, call `triggerZoomToSection(selection.sectionId)`
- If no section selected, no-op (do nothing)

## Key context

- Keyboard shortcuts must not fire when user is typing in input/textarea
- Existing guards in useKeyboardShortcuts handle this
## Acceptance
- [ ] Ctrl+G handler added to useKeyboardShortcuts
- [ ] Zooms to selected section when section is selected
- [ ] No-op when no section is selected
- [ ] Does not interfere with text input (existing guards)
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
