# fn-28-rpu.1 Fix Rust undo/redo entry preservation on failure

## Description

Fix the undo/redo entry loss bug in the Rust backend. Currently, `undo()`, `redo()`, `undo_to()`, and `redo_to()` pop entries from the stack before attempting the operation, then only push to the opposite stack on success. On failure, the entry is permanently lost.

**Size:** M
**Files:** `src-tauri/src/core/state/undo.rs`

## Approach

**Critical structural change:** Restructure `undo()` and `redo()` so that **all post-pop failure paths flow through a single epilogue** — no early `return` statements after the entry has been popped. The current code has multiple `return CommandResult::failure(...)` inside match arms after the pop (project lock failure at line 401, no project at line 406, etc.). All of these must be eliminated or routed through a push-back epilogue.

Options:
1. **Guard pattern**: Collect the result into a variable, then at the end check success/failure and push to the appropriate stack.
2. **Single-exit**: Refactor nested matches into a helper that returns Result, then handle Ok/Err at the top level with push logic.

- In `undo()` (lines 330-520): After popping entry, run all operation logic without early returns. At the end, if success push to redo stack; if failure push back to undo stack. Follow pattern at `src-tauri/src/core/undo.rs:180-182` for `push_undo()`.
- In `redo()` (lines 522-565): Same restructuring — push back to redo stack on failure. Use `push_redo()` at `src-tauri/src/core/undo.rs:170-172`.
- In `undo_to()` (lines 744-777): Stop loop on first failure. Return enhanced message: `"Undo failed at step {current} of {total}: {reason}"`. Completed steps stay undone, failed entry pushed back.
- In `redo_to()` (lines 779-813): Same as undo_to but for redo direction.
- Add `tracing::error!` with **safe summary fields** on every failure where an entry was popped: `command = %entry.command.description()`, undo data variant name, and failure reason. **Do NOT log full snapshot JSON** — can be huge and may leak project data.
- Lock strategy is implementer's choice. Either hold undo_stack lock for entire operation, or use two-lock with push-back on failure. Both acceptable as long as entries are never lost.

## Key context

- `push_undo()` at `src-tauri/src/core/undo.rs:180` does NOT clear the redo stack (unlike `push_with_data`). Safe for push-back.
- `CommandResult::failure(error)` at `src-tauri/src/core/command.rs:205-213` — use for error returns.
- No changes to `CommandResult` struct — step count info goes in the message string only.
- If lock re-acquisition fails when pushing back, log `tracing::error!` — this is an extremely rare edge case (mutex poisoning).
- Pre-pop failures (lock failure on initial stack access, "Nothing to undo/redo") don't need entry-level logging since no entry exists.
- `Command::description()` returns a safe human-readable string — use this for logging, NOT debug output of the full command/undo_data.

## Acceptance
- [ ] `undo()` pushes entry back to top of undo stack on failure — no early returns after pop
- [ ] `redo()` pushes entry back to top of redo stack on failure — no early returns after pop
- [ ] `undo_to()` stops on failure, returns message with step count (e.g., "Undo failed at step 3 of 5: section not found")
- [ ] `redo_to()` stops on failure, returns message with step count
- [ ] `tracing::error!` logged when a popped entry's operation fails (safe summary: command description, undo data variant, reason — no full snapshots)
- [ ] No changes to `CommandResult` struct
- [ ] All existing undo/redo tests continue to pass
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
