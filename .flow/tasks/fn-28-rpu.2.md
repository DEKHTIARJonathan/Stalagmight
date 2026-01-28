# fn-28-rpu.2 Add Rust unit tests for undo/redo failure scenarios

## Description

Add Rust unit tests that verify undo/redo entries are preserved (pushed back to original stack) when operations fail. Tests should cover both single-step failures and multi-step partial completion.

**Size:** M
**Files:** `src-tauri/src/core/state/tests.rs`

## Approach

- Follow existing test patterns in `src-tauri/src/core/state/tests.rs` — uses `test_undo_*` / `test_redo_*` naming convention.
- Test failure assertion pattern: `assert!(!result.success); assert_eq!(result.error.as_deref(), Some("expected error"));`
- Use existing poison mutex helper at `tests.rs:26-31` for lock failure tests if applicable.
- Create scenarios where undo/redo operations fail (e.g., entity not found, invalid JSON in snapshot) and verify the entry remains on its original stack.
- For `undo_to`/`redo_to`, create multi-entry scenarios where an intermediate step fails, verify partial completion and enhanced message format.

## Key context

- Existing test file at `src-tauri/src/core/state/tests.rs` already has undo/redo tests — follow same setup patterns.
- `test_undo_fails_with_invalid_previous_values_shot` already tests a failure case but does NOT verify entry preservation — this test may need updating.
- CommandResult has `success: bool`, `error: Option<String>` — check both.
- After failed undo, verify entry is still at top of undo stack (not on redo stack, not lost).
## Acceptance
- [ ] Unit test: undo() failure preserves entry on undo stack
- [ ] Unit test: redo() failure preserves entry on redo stack
- [ ] Unit test: undo_to() partial completion — stops at failed step, returns enhanced message with step count
- [ ] Unit test: redo_to() partial completion — stops at failed step, returns enhanced message with step count
- [ ] Unit test: verify entry is at TOP of original stack after push-back (LIFO order preserved)
- [ ] All existing undo/redo tests continue to pass
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
## Done summary
Added 9 Rust unit tests verifying undo/redo entry preservation on failure: undo() and redo() push entries back to their original stack on failure, LIFO order is preserved, undo_to()/redo_to() stop at the failed step with enhanced error messages including step counts, and entries are preserved across ProjectSnapshot and project lock failure scenarios.
## Evidence
- Commits: cb36b518063e1b7a6e1e23a1b5cf1f8b3b3b4b0c, e1ff2bb6c517317f27f9fe480f1db9dde3d668c2
- Tests: cargo test --manifest-path src-tauri/Cargo.toml -- undo, cargo test --manifest-path src-tauri/Cargo.toml -- redo, cargo test --manifest-path src-tauri/Cargo.toml
- PRs: