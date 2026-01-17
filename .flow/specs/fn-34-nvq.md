# Rust Tests: AppState Command Execution

## Overview
Implement comprehensive unit tests for all core AppState command execution methods in `src-tauri/src/core/state.rs`. These tests validate commands like CreateSection, MergeStations, SetZeroDatum, UpdateShot, DeleteShot, CreateShot, DeleteSection, and UpdateSectionMetadata work correctly.

## Scope
- Target: `src-tauri/src/core/state.rs`
- Category: Rust Unit Tests
- Tests: 8
- Priority: P0 - Critical

## Approach
1. Create test module with `#[cfg(test)]` in state.rs or tests/ directory
2. Use `tempfile` for any persistence tests
3. Test each command type in isolation
4. Test edge cases for validation and error handling

## Quick commands
- `cd src-tauri && cargo test state::tests -- --nocapture`

## Acceptance
- [ ] Test 1.1: `test_execute_create_section_command` - Verify CreateSection creates section correctly
- [ ] Test 1.2: `test_execute_merge_stations_command` - Verify MergeStations updates offsets
- [ ] Test 1.3: `test_execute_set_zero_datum_command` - Verify SetZeroDatum stores GPS coordinates
- [ ] Test 1.4: `test_execute_update_shot_command` - Verify UpdateShot modifies data
- [ ] Test 1.5: `test_execute_delete_shot_command` - Verify DeleteShot handles section splits
- [ ] Test 1.6: `test_execute_create_shot_command` - Verify CreateShot inserts correctly
- [ ] Test 1.7: `test_execute_delete_section_command` - Verify DeleteSection cleans up merges
- [ ] Test 1.8: `test_execute_update_section_metadata_command` - Verify metadata updates
- [ ] Edge case tests for validation errors
- [ ] All tests pass with `cargo test`
- [ ] No new clippy warnings

## References
- Source: `tasks/task-01-appstate-commands.md`
