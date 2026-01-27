# Fix undo/redo entry loss when operation fails

## Problem

When clicking undo, the action sometimes does not get added to the redo stack. The entry is also lost from the undo stack — it disappears entirely from both stacks.

**Root cause**: The `undo()` function in `src-tauri/src/core/state/undo.rs` pops the entry from the undo stack BEFORE attempting the undo operation, then only pushes to the redo stack if the operation succeeds (`result.success`). If the operation fails for any reason (lock acquisition failure, missing entity, JSON parse error), the entry is permanently lost from both stacks. The same anti-pattern exists in `redo()`.

**Code location**: `src-tauri/src/core/state/undo.rs:330-519` (undo), `522-565` (redo), `744-777` (undo_to), `798-813` (redo_to).

## Key Decisions

- **Failure policy**: On undo/redo failure, push the entry back to the TOP of its original stack (undo stack for failed undo, redo stack for failed redo). The entry must never be lost.
- **Fix both directions**: Fix both `undo()` and `redo()` — same pattern, same bug.
- **Error notification**: Show a toast notification to the user with specific failure reason (e.g., "Undo failed: section not found") using the existing `uiStore.showToast()` system with standard 3-second auto-clear.
- **Error flow**: Frontend checks `CommandResult.success` from the IPC invoke, shows toast on failure.
- **Frontend refresh**: Always call `refreshProjectState()` after undo/redo regardless of success/failure, so the UI reflects the actual stack state (entry pushed back).
- **Multi-step (undo_to/redo_to)**: Stop at the failed step, keep partial progress. Return enhanced message with step info (e.g., "Undo failed at step 3 of 5: section not found"). Message string only — no struct changes to CommandResult.
- **Logging**: Add `tracing::error!` in Rust backend when an undo/redo operation fails and entry is pushed back.
- **Lock strategy**: Implementer's choice on whether to hold the undo_stack lock for the entire operation or use two-lock with failure handling. Either approach is acceptable as long as entries are never lost.
- **Retry behavior**: No special handling for repeated failures on the same entry. The toast throttle (5-second cooldown per key) prevents toast spam. User can skip entries via the history dropdown.
- **Dropdown UI**: No visual changes to the undo history dropdown — entries look the same regardless of failure history.
- **No new CommandResult fields**: Step count info for undo_to/redo_to goes in the message string, not new struct fields.

## Edge Cases

- Lock acquisition failure after popping entry — entry must be pushed back to original stack
- Entity referenced by undo entry no longer exists (deleted section/shot/station) — entry pushed back, error logged
- JSON parse failure on snapshot-based undo — entry pushed back, specific parse error in toast
- `undo_to()` partial completion — some steps succeed before one fails; completed steps stay undone, failed entry pushed back
- Second lock acquisition failure (re-acquiring undo_stack lock to push to redo) — if this path exists, handle it so entry isn't lost
- Rapid repeated undo clicks hitting the same failing entry — toast throttle handles toast spam, no special entry handling needed
- `redo_to()` same edge cases as `undo_to()` but in reverse direction

## Open Questions

- Are there other callers that pop from undo/redo stacks besides `undo()`, `redo()`, `undo_to()`, `redo_to()`? Needs codebase search during planning.

## Acceptance

- [ ] `undo()` pushes entry back to top of undo stack on failure
- [ ] `redo()` pushes entry back to top of redo stack on failure
- [ ] `undo_to()` stops on failure, returns message with step count (e.g., "Undo failed at step 3 of 5: reason")
- [ ] `redo_to()` stops on failure, returns message with step count
- [ ] `tracing::error!` logged on every undo/redo failure with reason and entry details
- [ ] Frontend shows toast notification with specific failure reason on undo/redo failure
- [ ] Frontend calls `refreshProjectState()` on both success AND failure
- [ ] Rust unit tests verify entry preservation on undo failure
- [ ] Rust unit tests verify entry preservation on redo failure
- [ ] Rust unit tests verify undo_to partial completion and enhanced message
- [ ] Playwright E2E test for undo/redo happy path (entry moves between stacks correctly)
- [ ] All existing undo/redo tests continue to pass
