# Undo/Redo Dropdown Stays Open on Action

## Overview

When the undo/redo history dropdown is open, performing an action (button click, item click, or Ctrl+Z/Y) currently calls `hardClose()` which closes the dropdown. Instead, the dropdown should stay open, show a loading indicator, refresh its content, and only close when the stack empties or the user explicitly dismisses it.

## Scope

**In scope:**
- Stay-open behavior for button click, item click, and keyboard shortcuts
- Loading indicator during refresh
- Sequential action queue for rapid clicks
- Auto-close on empty stack
- Navigation and scroll reset after refresh
- Detail preview dismissal on action
- Fixed 5-item dropdown height (was 10)
- Enhanced error dialog with stack trace and copy-to-clipboard
- aria-live announcements for accessibility
- SPEC.md and TESTING.md updates
- E2E test updates and additions

**Out of scope:**
- Cross-stack behavior (undo/redo dropdowns are independent)
- Backend changes (commands already support the needed operations)

## Approach

Modify `UndoHistoryDropdown.tsx` to replace `hardClose()` calls in action paths with an action-then-refresh pattern. Add `isActionInProgress` state for loading indication and queue management. The dropdown's `fetchStack()` is called after each action completes to refresh content.

### Keyboard shortcut coordination

There is a global `useKeyboardShortcuts` handler that fires on Ctrl+Z/Y. When the dropdown is open and intercepts Ctrl+Z/Y, it must call `stopPropagation()` and `preventDefault()` to prevent the global handler from also executing the action (which would cause a double-undo/redo). The dropdown handles the action itself (calling the correct undo or redo based on the key pressed) and then refreshes its contents.

### Error handling via CommandResult

The undo/redo store functions (`undo()`, `redo()`, `undoTo()`, `redoTo()`) return `CommandResult` objects and do **not** throw on failure. Error handling must check `result.success === false` and populate the ErrorDialog from `result.error` (and any available details). A try/catch should also wrap the calls to handle unexpected thrown exceptions, but the primary error path is the `CommandResult` check.

### Fixed dropdown height

The dropdown must use a fixed `height` (not just `maxHeight`) of ~220px to maintain the 5-item container size even when fewer items are present. Use `height: '220px'` with `overflow-y: auto` to achieve consistent sizing regardless of item count.

Key reuse points:
- `hardClose()` helper (`UndoHistoryDropdown.tsx:203-236`) — keep for Escape/click-outside/mouse-leave; remove from action handlers
- `fetchStack()` (`UndoHistoryDropdown.tsx:239-249`) — call after each action to refresh
- `refreshUndoState()` (`projectStore.ts:771-781`) — already called by undo/redo actions
- `ErrorDialog` (`ErrorDialog.tsx`) — enhance for stack trace display
- `DialogWrapper` (`DialogWrapper.tsx`) — wrap error dialog
- aria-live pattern (`ShortcutRecorder.tsx:326-333`) — reuse for announcements
- `LoadingProgress.tsx:85-156` — reference copy-to-clipboard pattern

## Risks / Dependencies

- **Epic dependencies**: fn-28-rsu (undo entry loss on failure), fn-30-wcf (zero datum two entries), fn-40-tub (merge/closure undo bug) — all modify undo/redo stack behavior. These should ideally land first to avoid conflicting stack semantics. However, fn-25-itw's changes are primarily UI-level (dropdown behavior) and don't modify backend stack logic, so they can proceed independently.
- **Test breakage**: Existing e2e tests expect dropdown to close after actions. These must be updated.
- **Race conditions**: Rapid clicks could cause stale state if not properly queued. Use sequential await chain.
- **Double-undo risk**: Global keyboard shortcut handler must be prevented from firing when dropdown handles Ctrl+Z/Y via `stopPropagation`/`preventDefault`.

## Quick commands

```bash
# Type check
pnpm tsc --noEmit

# E2E tests (undo-redo dropdown specific)
pnpm test:ui -- --grep "undo"

# All E2E tests
pnpm test:ui

# Rust tests (backend unchanged, sanity check)
cargo test --manifest-path src-tauri/Cargo.toml
```

## Acceptance

- [ ] Clicking undo/redo button while dropdown is open keeps dropdown open and refreshes item list
- [ ] Clicking a dropdown item performs the action and refreshes the dropdown (stays open)
- [ ] Ctrl+Z/Y/Shift+Z while dropdown is open performs action and refreshes dropdown
- [ ] No double-undo/redo when using keyboard shortcuts while dropdown is open
- [ ] Dropdown closes automatically when stack becomes empty
- [ ] Small loading indicator shown at top of dropdown during async refresh
- [ ] Keyboard navigation and scroll position reset to top after refresh
- [ ] Detail preview popup dismissed on any action
- [ ] Rapid clicks queue and execute sequentially with refresh after each
- [ ] Dropdown fixed at 5-item height with scrollable content (fixed height, not just maxHeight)
- [ ] Auto-hide scrollbar preserved
- [ ] Critical error shown in modal dialog with full details, stack trace, and copy-to-clipboard
- [ ] Error detected via CommandResult.success === false (not just try/catch)
- [ ] aria-live region announces refresh and remaining item count
- [ ] Mouse leave and click-outside still close dropdown even during action
- [ ] Escape key still closes dropdown
- [ ] SPEC.md section 6.3 updated (close behavior + scrolling height)
- [ ] SPEC.md section 11.3 updated (ARIA live regions)
- [ ] TESTING.md updated
- [ ] Existing e2e tests updated, new tests added for all new behaviors

## References

- Epic spec: `.flow/specs/fn-25-itw.md`
- Main component: `src/components/SingleSystemView/UndoHistoryDropdown.tsx`
- Store actions: `src/store/projectStore.ts:727-781`
- Backend commands: `src-tauri/src/commands/history.rs:44-126`
- Toolbar integration: `src/components/SingleSystemView/Toolbar.tsx:56-77`
- Error dialog: `src/components/Dialogs/ErrorDialog.tsx`
- Dialog wrapper: `src/components/Dialogs/DialogWrapper.tsx`
- aria-live pattern: `src/components/ShortcutRecorder/ShortcutRecorder.tsx:326-333`
- Copy-to-clipboard pattern: `src/components/LoadingProgress/LoadingProgress.tsx:85-156`
- E2E tests: `e2e-playwright/undo-redo-dropdown.spec.ts`
- SPEC.md section 6.3: `docs/SPEC.md`
- TESTING.md: `docs/TESTING.md`
