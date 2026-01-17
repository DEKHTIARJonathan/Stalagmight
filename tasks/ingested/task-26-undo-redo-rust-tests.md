# Task 26: Add Rust unit tests for undo/redo

## Overview
Add comprehensive unit tests for the undo/redo system in the Rust backend, covering undo stack, redo stack, and complex operation sequences.

## Priority
High - Phase 7 (Testing & Quality)

## Risk Level
Low

## Dependencies
After features in Phases 1-6 implemented

## Files to Modify
- `src-tauri/src/core/undo.rs` - Add test module (or state.rs if combined)

## Specifications

### Test Coverage
- Full coverage of edge cases
- All undo/redo scenarios

### Redo Persistence
- Test that redo stack is stored in save file
- Test redo stack restored on load

### Batch Undo
- Test user choice for batch operations
- Test undo reverses batch correctly

### Test Areas

#### Undo Stack
- Test push command to undo stack
- Test undo pops from stack
- Test undo stack limit
- Test undo stack cleared on save (if applicable)

#### Redo Stack
- Test undo pushes to redo stack
- Test redo pops from redo stack
- Test redo stack cleared on new command
- Test redo stack persistence in save file

#### Complex Operations
- Test undo after multiple commands
- Test redo after undo
- Test undo-redo-undo sequence
- Test operation after redo (clears redo stack)

### Test Structure
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_undo_single_command() { }

    #[test]
    fn test_redo_after_undo() { }

    #[test]
    fn test_redo_cleared_on_new_command() { }

    // ... more tests
}
```

## Acceptance Criteria
- [ ] Undo stack tests pass
- [ ] Redo stack tests pass
- [ ] Complex operation tests pass
- [ ] Redo persistence tests pass
- [ ] Batch undo tests pass
- [ ] All tests in `cargo test` suite
- [ ] Edge cases covered

## Test Requirements

### Specific Tests to Write
- `test_undo_single_command`
- `test_undo_multiple_commands`
- `test_redo_after_undo`
- `test_redo_cleared_on_new_command`
- `test_undo_stack_limit`
- `test_redo_stack_persisted`
- `test_redo_stack_restored`
- `test_undo_redo_undo_sequence`
- `test_batch_undo`

## Edge Cases
- Undo with empty stack
- Redo with empty stack
- Undo at stack limit
- Save clears undo? (depending on design)
- Rapid undo/redo
- Undo after load

## Implementation Notes
- Test both inverse commands and state snapshots
- Verify hybrid undo system works correctly
- Consider memory usage with large undo stacks
- Low risk: testing existing code
