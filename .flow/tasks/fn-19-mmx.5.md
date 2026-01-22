# fn-19-mmx.5 Add validation for duplicate datum in connected group

## Description
Add validation to prevent setting a second zero datum on a station that is in the same connected group as an existing datum.

**Size:** S
**Files:** `src-tauri/src/models/project.rs`

## Approach

1. Before setting datum, call `get_connected_section_ids()` for the target station
2. Check if any station in connected group already has `is_zero_datum: true`
3. If yes, return error: "This station group already has a zero datum at Station X"
4. Allow setting datum if no existing datum in connected group

## Key context

One datum per connected group rule. Disconnected groups can each have their own datum. The validation must traverse merges to find all stations in the group.
## Acceptance
- [ ] Error returned when trying to set duplicate datum in same group
- [ ] Error message identifies existing datum station
- [ ] Disconnected groups can each have their own datum
- [ ] Validation runs before any state changes
- [ ] Rust tests pass (cargo test)
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
