# fn-14-3zg.5 Frontend: Keyboard navigation for dropdown

## Description
Add keyboard navigation to the undo/redo dropdown: Arrow Down to open, arrow keys to navigate, Enter to select, Escape to close.

**Size:** S
**Files:**
- `src/components/SingleSystemView/UndoHistoryDropdown.tsx` - Add keyboard handlers
- `src/hooks/useKeyboardShortcuts.ts` - Ensure dropdown Escape takes priority

## Approach

1. When button focused, Arrow Down opens dropdown and focuses first item
2. Arrow Up/Down navigates items with roving tabindex pattern
3. Auto-scroll to keep selected item visible
4. Enter executes selected item action
5. Escape closes dropdown and returns focus to trigger button
6. Coordinate with existing Escape handling via data-dropdown-open attribute

## Key Context

- ARIA menu pattern: role="menu" on list, role="menuitem" on items
- Use aria-activedescendant to track focus without moving DOM focus
- See memory note: "Keyboard event handler state - use refs for values needed in handlers"
- Existing dropdown Escape check at `useKeyboardShortcuts.ts:276`
## Acceptance
- [ ] Arrow Down on focused button opens dropdown
- [ ] Arrow Up/Down navigates items in list
- [ ] Selected item auto-scrolls into view
- [ ] Enter executes selected item action and closes dropdown
- [ ] Escape closes dropdown and returns focus to button
- [ ] ARIA attributes: role="menu", role="menuitem", aria-activedescendant
- [ ] Works with screen readers (test with accessibility tools)
- [ ] pnpm tsc --noEmit passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
