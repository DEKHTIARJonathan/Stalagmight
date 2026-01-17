# fn-35-f4v.1 Implement 8 undo/redo tests

## Description
TBD

## Acceptance
- [ ] TBD

## Done summary
Implemented 5 comprehensive undo/redo tests in state.rs (8 required tests now exist):
- test_undo_delete_shot: verify undoing DeleteShot restores shot
- test_undo_merge_stations: verify undoing MergeStations removes merge
- test_multiple_undo_sequence: verify multiple undos in LIFO order
- test_redo_clears_on_new_command: verify new command clears redo stack
- test_undo_stack_limits: verify stack limits and overflow handling

Note: 3 tests already existed (test_undo_create_section, test_redo_create_section, test_undo_update_shot)
## Evidence
- Commits: 432396d58dea5b0b0cd04a1cce72c3cba0c26e5b
- Tests: cargo test state::tests::test_undo, cargo test state::tests::test_redo, cargo test state::tests::test_multiple
- PRs: