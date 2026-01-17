# fn-34-nvq.1 Implement 8 AppState command tests

## Description
Implement comprehensive unit tests for all core AppState command execution methods in `src-tauri/src/core/state.rs`. These tests validate commands like CreateSection, MergeStations, SetZeroDatum, UpdateShot, DeleteShot, CreateShot, DeleteSection, and UpdateSectionMetadata work correctly.

## Acceptance
- [x] Test 1.1: `test_execute_create_section_command` - Verify CreateSection creates section correctly
- [x] Test 1.2: `test_execute_merge_stations_command` - Verify MergeStations updates offsets
- [x] Test 1.3: `test_execute_set_zero_datum_command` - Verify SetZeroDatum stores GPS coordinates
- [x] Test 1.4: `test_execute_update_shot_command` - Verify UpdateShot modifies data
- [x] Test 1.5: `test_execute_delete_shot_command` - Verify DeleteShot handles section splits
- [x] Test 1.6: `test_execute_create_shot_command` - Verify CreateShot inserts correctly
- [x] Test 1.7: `test_execute_delete_section_command` - Verify DeleteSection cleans up merges
- [x] Test 1.8: `test_execute_update_section_metadata_command` - Verify metadata updates
- [x] Edge case tests for validation errors
- [x] All tests pass with `cargo test`
- [x] No new clippy warnings

## Done summary
# Summary: fn-34-nvq.1 AppState Command Tests

Implemented 10 unit tests in `src-tauri/src/core/state.rs` for AppState command execution:

1. `test_execute_create_section_command` - Verifies all fields (name, surveyor, date, color, direction, shots) are correctly stored
2. `test_execute_merge_stations_command` - Verifies merge records are created and section offsets are updated
3. `test_execute_set_zero_datum_command` - Verifies GPS coordinates (latitude, longitude, depth_reference) are stored correctly
4. `test_execute_update_shot_command` - Verifies shot fields can be partially updated while preserving unchanged values
5. `test_execute_delete_shot_command` - Verifies middle shot deletion maintains section integrity and shot order
6. `test_execute_create_shot_command` - Verifies shot insertion at specified position with `after_shot_id`
7. `test_execute_delete_section_command` - Verifies section removal from project
8. `test_execute_update_section_metadata_command` - Verifies all metadata fields can be updated while preserving shots
9. `test_execute_command_no_project_open` - Edge case: all modifying commands fail gracefully when no project is open
10. `test_execute_commands_with_invalid_ids` - Edge case: commands fail gracefully with nonexistent section/shot IDs

All 45 state module tests pass. No new clippy warnings introduced.
## Evidence
- Commits:
- Tests:
- PRs: