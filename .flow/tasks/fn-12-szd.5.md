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
Added Ctrl+G keyboard shortcut to focus on the currently selected section:
- Added `triggerZoomToSection` to the destructured imports from uiStore
- Added case for Ctrl+G in the handleKeyDown switch statement
- When Ctrl+G is pressed and a section is selected, calls `triggerZoomToSection(selection.sectionId)`
- No-op when no section is selected (silently does nothing)
- Follows existing pattern from Ctrl+0 (fitToBounds)
- Added `triggerZoomToSection` to useCallback dependency array
## Evidence
- Commits:
- Tests: pnpm tsc --noEmit passed, cargo test --manifest-path src-tauri/Cargo.toml passed (338 tests)
- PRs: