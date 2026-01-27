## Description

Enhance the existing `ErrorDialog` component to display full error details with stack trace and a copy-to-clipboard button for bug reporting. Add an aria-live region to `UndoHistoryDropdown` that announces remaining item count after each action.

**Size:** M
**Files:**
- `src/components/Dialogs/ErrorDialog.tsx` (enhance with stack trace + copy-to-clipboard)
- `src/components/SingleSystemView/UndoHistoryDropdown.tsx` (add aria-live region + wire error dialog)

## Approach

### Error dialog enhancement

The existing `ErrorDialog.tsx` is minimal (23 lines). Enhance it to accept:
- `error` prop (Error object or string) with stack trace
- Display error message prominently, stack trace in a scrollable code block
- Add "Copy to clipboard" button — follow the pattern at `LoadingProgress.tsx:85-156`
- Add text recommending the user report the bug
- Use existing `DialogWrapper` component (`DialogWrapper.tsx:1-147`)

Check if `ErrorDialog` is used elsewhere in the codebase before modifying its props interface. If it is, ensure backwards compatibility or update all call sites.

### Wire error handling in dropdown (CommandResult pattern)

The undo/redo store functions (`undo()`, `redo()`, `undoTo()`, `redoTo()`) return `CommandResult` objects and do **not** throw on failure. Error handling must:

1. Check `result.success === false` after each action call — this is the **primary** error path
2. Populate the enhanced ErrorDialog from `result.error` (message and any available stack trace or details)
3. Also wrap calls in try/catch to handle unexpected thrown exceptions as a secondary safety net
4. On either error path: set `isActionInProgress` to false (clear loading state), show ErrorDialog, keep dropdown open (do NOT close on error)

<!-- Updated by plan-sync: fn-25-itw.1 implemented action queue pattern that discards CommandResult -->
**Implementation note (from fn-25-itw.1):** The action queue currently discards `CommandResult` objects. Action calls use `.then(() => {})` which strips the return value (see `enqueueAction(() => action().then(() => {}))` in `handleItemClick`, `handleButtonClick`, and the Ctrl+Z/Y handler). To wire error handling:
- Modify the action lambdas to return or capture the `CommandResult` instead of discarding it (remove `.then(() => {})`)
- Error handling logic should be added inside `processQueue()` (lines 269-305), which centrally manages `isActionInProgress` state and the refresh cycle
- The existing `catch` in `processQueue` (line 280) only logs to console — enhance it to show ErrorDialog
- A `clearPreviewState()` helper already exists (lines 211-215) for dismissing the detail preview

### aria-live region

Add a visually-hidden `<span>` with `role="status" aria-live="polite" aria-atomic="true"` to the dropdown. Follow the pattern at `ShortcutRecorder.tsx:326-333` and the `sr-only` CSS class.

After each action+refresh completes, update the span text to announce: "N actions remaining" (where N is the refreshed item count). If stack is empty (dropdown about to close), announce "No actions remaining".

Existing precedent: `docs/TESTING.md:600-624` documents `#selection-announcer` with the same pattern.

## Key context

- Existing `ErrorDialog.tsx` uses `DialogWrapper` with `data-testid="error-dialog"`
- `LoadingProgress.tsx:85-156` has a copy-to-clipboard button pattern to reuse
- aria-live with `aria-atomic="true"` announces the entire region content, not just changes — correct for count announcements
- Use `aria-live="polite"` (not "assertive") per WAI-ARIA best practices
- **Critical**: undo/redo functions return `CommandResult`, NOT throw on failure. Must check `result.success === false` as primary error detection, with try/catch as secondary safety net.
<!-- Updated by plan-sync: fn-25-itw.1 used enqueueAction/processQueue pattern -->
- The action queue is managed by `enqueueAction()` and `processQueue()` in `UndoHistoryDropdown.tsx`. `processQueue()` (lines 269-305) is the central loop that executes actions sequentially, calls `fetchStack()` after each, resets `activeIndex` to 0, and handles close-on-empty. All action paths (item click, button click, Ctrl+Z/Y) go through `enqueueAction()`.
- `ShortcutRecorder.tsx` aria-live pattern is at `src/components/Settings/ShortcutRecorder.tsx:326-333` (not `src/components/ShortcutRecorder/`)
- An input focus guard exists (lines 555-562) that skips Ctrl+Z/Y interception when focus is in text inputs — aria-live announcements should still work regardless of focus location

## Acceptance

- [ ] ErrorDialog accepts error details with stack trace
- [ ] ErrorDialog displays stack trace in scrollable code block
- [ ] ErrorDialog has "Copy to clipboard" button that copies error + stack trace
- [ ] ErrorDialog includes text recommending user report the bug
- [ ] Backend error during undo/redo detected via `result.success === false` (CommandResult pattern)
- [ ] Unexpected thrown exceptions also caught via try/catch as secondary safety net
- [ ] Error shows enhanced ErrorDialog with details from CommandResult
- [ ] Dropdown stays open after error (does not close)
- [ ] Loading state cleared on error
- [ ] aria-live region announces "N actions remaining" after each action
- [ ] aria-live region uses `role="status"`, `aria-live="polite"`, `aria-atomic="true"`
- [ ] Announcement span is visually hidden (`sr-only` class)
- [ ] Existing ErrorDialog call sites still work (backwards compatible)
- [ ] `pnpm tsc --noEmit` passes

## Done summary

<!-- filled on completion -->

## Evidence

<!-- filled on completion -->
