## Description

Modify `UndoHistoryDropdown.tsx` to keep the dropdown open when performing undo/redo actions. Replace `hardClose()` calls in action handlers with an action-then-refresh pattern. Add sequential action queuing for rapid clicks, a loading indicator, and auto-close when the stack empties.

**Size:** M
**Files:**
- `src/components/SingleSystemView/UndoHistoryDropdown.tsx` (primary — all behavioral changes)
- `src/components/SingleSystemView/Toolbar.tsx` (if `onSingleAction` prop contract changes)

## Approach

### Stay-open behavior

Remove `hardClose()` calls from these action paths (keep it for Escape, click-outside, mouse-leave):
- `handleItemClick` (line ~371) — replace with action + refresh
- `handleButtonClick` (line ~451) — replace with action + refresh
- Ctrl+Z/Y handler (line ~485) — replace with action + refresh

After each action completes:
1. Call `fetchStack()` to refresh the dropdown content
2. Check if stack is now empty → if so, call `hardClose()`
3. Reset `keyboardIndex` to 0 and scroll to top
4. Clear `hoveredItem`, `hoveredItemRect`, `dropdownRect` (dismiss detail preview)

### Keyboard shortcut coordination (prevent double-undo)

The global `useKeyboardShortcuts` handler also fires on Ctrl+Z/Y. When the dropdown is open and intercepts these keys, it **must** call `stopPropagation()` and `preventDefault()` on the event to prevent the global handler from also executing the action. The dropdown handles the action itself (calling the correct `undo` or `redo` based on the key pressed) and then refreshes. Verify that the dropdown's keyboard handler fires before the global one (it should, since it's closer in the DOM tree).

### Sequential action queue

Add `isActionInProgress` state (boolean). When an action starts, set to `true`. When it completes (after refresh), set to `false`. If a new action is triggered while `isActionInProgress` is true, queue it. Execute queued actions sequentially via an async chain (await previous before starting next). Allow unlimited queuing (button stays enabled).

Follow the operation guard pattern from `projectStore.ts:471` (`isClosing` flag).

### Loading indicator

When `isActionInProgress` is true, show a small spinner/loading indicator at the top of the dropdown (below any header, above the item list). Items remain visible but dimmed (reduced opacity). Use an inline spinner — follow existing loading patterns in the codebase.

### Height change

Change dropdown from `maxHeight: '440px'` (line ~593) to a **fixed** `height: '220px'` with `overflow-y: auto` (5 items instead of 10). A fixed `height` (not just `maxHeight`) ensures the container maintains its 5-item size even when fewer items are present. Preserve auto-hide scrollbar behavior.

### Close-on-empty

After each action+refresh cycle, check `items.length`. If 0, call `hardClose()`. This handles the "last action undone/redone" edge case.

### Navigation and scroll reset

After refresh, set `keyboardIndex` to 0 (or -1 if using 0-based with "no selection" state). Call `scrollTo({ top: 0 })` on the scroll container ref.

### Detail preview dismissal

On action trigger (before async call), clear `hoveredItem` state to dismiss the detail preview popup immediately. The existing `hardClose()` already clears these (lines 225-228) — extract that clearing logic into a reusable helper.

## Key context

- `fetchStack()` (`UndoHistoryDropdown.tsx:239-249`) fetches the full stack from backend. Call it after action completes.
- `refreshUndoState()` (`projectStore.ts:771-781`) only updates `canUndo`/`canRedo` booleans — it does NOT refresh the stack items displayed in the dropdown. The dropdown must call its own `fetchStack()`.
- Memory pitfall: props used in setTimeout callbacks become stale closures — track in a ref (from project memory).
- Mouse leave during action: dropdown closes immediately per spec (mouse leave is NOT suppressed during actions).
- The global keyboard shortcut handler (`useKeyboardShortcuts`) must NOT fire when the dropdown handles Ctrl+Z/Y — use `stopPropagation()` + `preventDefault()`.

## Acceptance

- [ ] Clicking undo/redo button while dropdown is open keeps dropdown open and refreshes item list
- [ ] Clicking a dropdown item performs multi-step action and refreshes the dropdown (stays open)
- [ ] Ctrl+Z/Y/Shift+Z while dropdown is open performs action and refreshes dropdown
- [ ] No double-undo/redo when using Ctrl+Z/Y while dropdown is open (stopPropagation prevents global handler)
- [ ] Dropdown closes automatically when stack becomes empty after action
- [ ] Small loading indicator shown at top of dropdown during action
- [ ] Items dimmed during loading
- [ ] Keyboard navigation index resets to top (index 0) after refresh
- [ ] Scroll position resets to top after refresh
- [ ] Detail preview popup dismissed immediately on any action trigger
- [ ] Rapid clicks queue and execute sequentially with refresh after each
- [ ] Dropdown uses fixed `height: '220px'` (not just maxHeight) with `overflow-y: auto`
- [ ] Dropdown maintains 5-item height even with fewer items
- [ ] Auto-hide scrollbar preserved
- [ ] Mouse leave still closes dropdown even during an action in flight
- [ ] Click outside still closes dropdown even during an action in flight
- [ ] Escape key still closes dropdown
- [ ] `pnpm tsc --noEmit` passes

## Done summary

<!-- filled on completion -->

## Evidence

<!-- filled on completion -->
