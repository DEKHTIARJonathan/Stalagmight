# fn-43-uvi.3 Add unit tests for MoveSection and MoveStation undo

## Description

Add comprehensive unit tests for both commands.

**File:** `src-tauri/src/core/state/tests.rs`

### Tests to Add

<!-- Updated by plan-sync: fn-43-uvi.1 already added MoveSection tests (test_move_section, test_move_section_undo_redo, test_move_nonexistent_section) in tests.rs lines 1333-1451. Only MoveStation tests remain. -->

```rust
// MoveSection tests — ALREADY IMPLEMENTED by fn-43-uvi.1:
// - test_move_section (tests.rs:1336) — covers offset updates and accumulation
// - test_move_section_undo_redo (tests.rs:1385) — covers undo and redo
// - test_move_nonexistent_section (tests.rs:1437) — covers error case

// MoveStation tests — STILL NEEDED:
#[test]
fn test_move_station_updates_offsets() {
    // Move station, verify station_offsets updated
}

#[test]
fn test_move_station_undo() {
    // Move station, undo, verify offset restored
}

#[test]
fn test_move_station_redo() {
    // Move, undo, redo, verify offset re-applied
}

#[test]
fn test_station_offset_applied_in_coordinates() {
    // Move station, call compute_station_coordinates
    // Verify returned station includes the offset
}
```

## Acceptance

- [x] test_move_section_updates_offsets passes (already done in fn-43-uvi.1 as test_move_section)
- [x] test_move_section_undo passes (already done in fn-43-uvi.1 as test_move_section_undo_redo)
- [x] test_move_section_redo passes (already done in fn-43-uvi.1 as test_move_section_undo_redo)
- [ ] test_move_station_updates_offsets passes
- [ ] test_move_station_undo passes
- [ ] test_move_station_redo passes
- [ ] test_station_offset_applied_in_coordinates passes
- [ ] All existing tests still pass

## Done summary
Added 4 unit tests for MoveStation command:

1. `test_move_station_updates_offsets` — verifies station_offsets are set and accumulated across two moves
2. `test_move_station_undo` — verifies undo reverses the move back to origin
3. `test_move_station_redo` — verifies redo re-applies the move after undo
4. `test_station_offset_applied_in_coordinates` — verifies compute_station_raw_coords includes the station offset

All 4 new tests pass. Full test suite (733 unit + 80 integration) passes with 0 failures.
## Evidence
- Commits: 35da968
- Tests: test_move_station_updates_offsets, test_move_station_undo, test_move_station_redo, test_station_offset_applied_in_coordinates
- PRs: