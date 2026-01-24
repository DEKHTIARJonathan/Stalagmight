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
## Summary

Added full keyboard navigation to the UndoHistoryDropdown component with proper ARIA attributes for accessibility.

### Changes Made

**src/components/SingleSystemView/UndoHistoryDropdown.tsx:**

1. **Keyboard navigation state**: Added `activeIndex` state to track currently focused menu item (-1 when none).

2. **New refs**: Added `buttonRef` for focus management, `scrollContainerRef` for auto-scrolling, and `menuId` (via useId) for ARIA IDs.

3. **Keyboard handlers**:
   - `handleButtonKeyDown`: Arrow Down opens dropdown and focuses first item
   - `handleDropdownKeyDown`: Arrow Up/Down navigates items (wrapping), Enter executes action, Escape closes and returns focus, Home/End jump to first/last item

4. **Auto-scroll**: `scrollActiveItemIntoView` function scrolls selected item into viewport using `scrollIntoView({ block: 'nearest', behavior: 'smooth' })`.

5. **ARIA attributes**:
   - Button: `aria-controls` pointing to menu ID
   - Dropdown: `aria-activedescendant` for virtual focus, `id` for menu
   - Menu items: `id` for aria-activedescendant reference, `aria-selected` for selected state, `tabIndex={-1}`

6. **Visual feedback**: Active item shows highlight via conditional `bg-background/50` class. Mouse hover also updates active index for consistent visual feedback.

7. **Focus management**: When opened via keyboard (Arrow Down), dropdown gets focus and first item is highlighted. Escape returns focus to trigger button.
## Evidence
- Commits:
- Tests: typescript, playwright, rust
- PRs:
