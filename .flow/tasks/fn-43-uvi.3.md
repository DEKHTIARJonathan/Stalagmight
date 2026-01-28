# fn-43-uvi.3 Add unit tests for MoveSection and MoveStation undo

## Description

Add comprehensive unit tests for both commands.

**File:** `src-tauri/src/core/state/tests.rs`

### Tests to Add

```rust
// MoveSection tests
#[test]
fn test_move_section_updates_offsets() {
    // Move section, verify section_offsets updated
    // Move again, verify accumulation (15.0, 10.0) not (5.0, -10.0)
}

#[test]
fn test_move_section_undo() {
    // Move section, undo, verify offset restored to (0.0, 0.0)
}

#[test]
fn test_move_section_redo() {
    // Move, undo, redo, verify offset re-applied
}

// MoveStation tests
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

- [ ] test_move_section_updates_offsets passes
- [ ] test_move_section_undo passes
- [ ] test_move_section_redo passes
- [ ] test_move_station_updates_offsets passes
- [ ] test_move_station_undo passes
- [ ] test_move_station_redo passes
- [ ] test_station_offset_applied_in_coordinates passes
- [ ] All existing tests still pass

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
