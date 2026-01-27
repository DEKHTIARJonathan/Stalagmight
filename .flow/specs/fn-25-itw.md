# Undo/Redo Dropdown Stays Open on Action

## Problem

Currently, clicking the undo or redo button (or a dropdown item, or pressing Ctrl+Z/Y) while the undo/redo history dropdown is open causes the dropdown to close immediately via `hardClose()`. The user loses visibility of the remaining undo/redo stack. The dropdown should instead stay open and refresh its contents, closing only when the stack becomes empty.

## Key Decisions

1. **Scope**: Both the main undo/redo button click AND clicking items within the dropdown list keep the dropdown open and refresh it.
2. **Keyboard shortcuts**: Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z while dropdown is open should also keep it open and refresh (consistent with click behavior).
3. **Empty stack closes**: When the last action is undone/redone and the stack becomes empty, the dropdown closes automatically.
4. **Navigation reset**: After any action, keyboard navigation index resets to top (index 0) and scroll position resets to top.
5. **Detail preview**: The hover detail preview popup is dismissed when any action fires; it reappears only when the user hovers a new item after refresh.
6. **Loading indicator**: A small loading indicator appears at the top of the dropdown while fetching the updated stack from the backend. Items remain visible (possibly dimmed) beneath it.
7. **Rapid clicks**: Clicks are allowed to queue up freely (button stays enabled). Each queued action executes sequentially, and the dropdown refreshes after each.
8. **Dropdown fixed height**: The dropdown is always exactly 5 items tall (~220px), with scrollable content for longer lists. This replaces the previous spec of 10 items / ~440px max height. Auto-hide scrollbar behavior is preserved.
9. **Error handling**: Undo/redo should never fail in normal operation. If it does fail, show a modal dialog with full error details and stack trace, recommending the user report the bug. Check for an existing error dialog component in the codebase before creating a new one.
10. **Accessibility**: Use an aria-live region to announce both the refresh and the remaining item count (e.g., "3 actions remaining") after each action.
11. **Cross-stack behavior**: Out of scope. Each dropdown (undo/redo) is independent; when undo stack empties, the undo dropdown closes and the redo button updates its chevron independently.

## Close Behavior (Updated)

The dropdown closes ONLY on:
- Mouse leaving the button/dropdown area (100ms buffer) — even during an action in flight
- Pressing Escape key
- Clicking outside the dropdown — even during an action in flight
- Stack becomes empty after an action

The dropdown stays OPEN on:
- Clicking the main undo/redo button (single-step action)
- Clicking a dropdown item (multi-step undo/redo to index N)
- Pressing Ctrl+Z, Ctrl+Y, or Ctrl+Shift+Z while dropdown is open

## Edge Cases

- **Last action undone/redone**: Stack empties → dropdown closes automatically
- **Rapid clicking**: Actions queue sequentially; dropdown refreshes after each completes
- **Mouse leave during action**: Dropdown closes immediately (mouse leave is not suppressed)
- **Click outside during action**: Dropdown closes immediately (not pinned open)
- **Backend error**: Show modal dialog with full error details, stack trace, and copy-to-clipboard for bug reporting
- **Hover + button click**: If user is hovering an item with detail preview visible, clicking the main button resets highlight and dismisses preview immediately; after refresh, navigation is at top
- **Multi-step batch action**: Single loading indicator for the entire `undo_to(N)` / `redo_to(N)` operation, then one refresh when complete
- **Dropdown height with few items**: Dropdown maintains fixed 5-item height even when fewer items are present

## Spec Updates Required

- Update SPEC.md section 6.3 "Close Behavior" to reflect the new rules
- Update SPEC.md section 6.3 "Scrolling" to reflect fixed 5-item height instead of 10-item max
- Update TESTING.md section on UndoHistoryDropdown if affected

## Test Requirements

- Update existing e2e tests in `undo-redo-dropdown.spec.ts` that may break
- Add new tests for:
  - Button click keeps dropdown open and refreshes items
  - Item click keeps dropdown open and refreshes items
  - Ctrl+Z/Y keeps dropdown open and refreshes items
  - Dropdown closes when stack becomes empty after action
  - Loading indicator appears during refresh
  - Navigation resets to top after refresh
  - Detail preview dismisses on action
  - Error dialog on backend failure (if testable)
  - Accessibility announcements after refresh

## Acceptance

- [ ] Clicking undo/redo button while dropdown is open keeps dropdown open and refreshes item list
- [ ] Clicking a dropdown item performs the action and refreshes the dropdown (stays open)
- [ ] Ctrl+Z/Y/Shift+Z while dropdown is open performs action and refreshes dropdown
- [ ] Dropdown closes automatically when stack becomes empty
- [ ] Small loading indicator shown at top of dropdown during async refresh
- [ ] Keyboard navigation and scroll position reset to top after refresh
- [ ] Detail preview popup dismissed on any action
- [ ] Rapid clicks queue and execute sequentially with refresh after each
- [ ] Dropdown fixed at 5-item height with scrollable content
- [ ] Auto-hide scrollbar preserved
- [ ] Critical error shown in modal dialog with full details
- [ ] aria-live region announces refresh and remaining item count
- [ ] Mouse leave and click-outside still close dropdown even during action
- [ ] Escape key still closes dropdown
- [ ] SPEC.md section 6.3 updated
- [ ] TESTING.md updated if affected
- [ ] Existing e2e tests updated, new tests added for all new behaviors
