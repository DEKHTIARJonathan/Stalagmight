# fn-28-rpu.1 Fix Rust undo/redo entry preservation on failure

## Description

Fix the undo/redo entry loss bug in the Rust backend. Currently, `undo()`, `redo()`, `undo_to()`, and `redo_to()` pop entries from the stack before attempting the operation, then only push to the opposite stack on success. On failure, the entry is permanently lost.

**Size:** M
**Files:** `src-tauri/src/core/state/undo.rs`

## Approach

- In `undo()` (lines 330-520): After popping entry and attempting the operation, check `result.success`. If false, push entry back to top of undo stack instead of pushing to redo stack. Follow pattern at `src-tauri/src/core/undo.rs:180-182` for `push_undo()`.
- In `redo()` (lines 522-565): Same fix — push entry back to top of redo stack on failure. Use `push_redo()` at `src-tauri/src/core/undo.rs:170-172`.
- In `undo_to()` (lines 744-777): Stop loop on first failure. Return enhanced message: `"Undo failed at step {current} of {total}: {reason}"`. Completed steps stay undone, failed entry pushed back.
- In `redo_to()` (lines 779-813): Same as undo_to but for redo direction.
- Add `tracing::error!` with structured fields (entry command type, error reason) on every failure path. Follow existing pattern: `tracing::error!(error = %e, "description")`.
- Lock strategy is implementer's choice. Either hold undo_stack lock for entire operation, or use two-lock with push-back on failure. Both acceptable as long as entries are never lost.

## Key context

- `push_undo()` at `src-tauri/src/core/undo.rs:180` does NOT clear the redo stack (unlike `push_with_data`). Safe for push-back.
- `CommandResult::failure(error)` at `src-tauri/src/core/command.rs:205-213` — use for error returns.
- No changes to `CommandResult` struct — step count info goes in the message string only.
- If lock re-acquisition fails when pushing back, log `tracing::error!` — this is an extremely rare edge case (mutex poisoning).
## Acceptance
- [ ] `undo()` pushes entry back to top of undo stack on failure
- [ ] `redo()` pushes entry back to top of redo stack on failure
- [ ] `undo_to()` stops on failure, returns message with step count (e.g., "Undo failed at step 3 of 5: section not found")
- [ ] `redo_to()` stops on failure, returns message with step count
- [ ] `tracing::error!` logged on every undo/redo failure with reason and entry details
- [ ] No changes to `CommandResult` struct
- [ ] All existing undo/redo tests continue to pass
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
