# fn-19-mmx.5 Add validation for duplicate datum in connected group

## Description
Confirm and improve the existing duplicate datum validation. The validation already exists via `find_connected_zero_datum()` - this task improves the error message and adds tests.

**Size:** S
**Files:** `src-tauri/src/models/project.rs`

## Approach

1. Review existing `find_connected_zero_datum()` logic for correctness
2. Improve error message to include the existing datum station identifier (e.g., "Section 3, Station 2")
3. Add/improve unit tests for the validation
4. Ensure error is returned before any state changes occur

**Note**: The validation already exists - do NOT duplicate the logic. Just improve the error message and test coverage.

## Key context

Current `Project::set_zero_datum()` calls `find_connected_zero_datum()` which uses station-level connectivity (not just section-level) to find existing datums.

## Acceptance
- [ ] Existing validation logic reviewed and confirmed correct
- [ ] Error message includes existing datum station identifier
- [ ] Error returned when trying to set duplicate datum in same group
- [ ] Disconnected groups can each have their own datum
- [ ] Validation runs before any state changes
- [ ] Unit tests for validation scenarios added/improved
- [ ] Rust tests pass (cargo test)

## Done summary
Improved duplicate datum validation error message to include station identifiers (section/station indices). Refactored get_connected_stations() to reuse get_connected_section_ids(). Added comprehensive unit tests for validation scenarios.
## Evidence
- Commits: 094a944, 0e40b6a
- Tests: cargo test --manifest-path src-tauri/Cargo.toml
- PRs: