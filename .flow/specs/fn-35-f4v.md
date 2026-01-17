# Rust Tests: Undo/Redo System

## Overview
Implement comprehensive unit tests for the undo/redo system in `src-tauri/src/core/state.rs`. These tests validate that commands can be undone and redone correctly, maintaining state consistency.

## Scope
- Target: `src-tauri/src/core/state.rs`
- Category: Rust Unit Tests
- Tests: 8
- Priority: P1 - High

## Approach
1. Test each command type's undo/redo behavior
2. Test multiple undo/redo sequences
3. Test stack behavior (LIFO ordering, clearing on new command)
4. Test edge cases (empty stacks, stack limits)

## Quick commands
- `cd src-tauri && cargo test state::tests::undo -- --nocapture`

## Acceptance
- [ ] Test 2.1: `test_undo_create_section` - Verify undoing CreateSection removes section
- [ ] Test 2.2: `test_redo_create_section` - Verify redoing CreateSection restores section
- [ ] Test 2.3: `test_undo_update_shot` - Verify undoing UpdateShot restores original values
- [ ] Test 2.4: `test_undo_delete_shot` - Verify undoing DeleteShot restores shot
- [ ] Test 2.5: `test_undo_merge_stations` - Verify undoing MergeStations resets offsets
- [ ] Test 2.6: `test_multiple_undo_sequence` - Verify multiple undos in LIFO order
- [ ] Test 2.7: `test_redo_clears_on_new_command` - Verify new command clears redo stack
- [ ] Test 2.8: `test_undo_stack_limits` - Verify stack limits and overflow handling
- [ ] All tests pass with `cargo test`
- [ ] No new clippy warnings

## References
- Source: `tasks/task-02-undo-redo.md`
