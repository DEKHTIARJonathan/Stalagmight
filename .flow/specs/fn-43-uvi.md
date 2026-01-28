# fn-43-uvi Bugfix: MoveSection and MoveStation commands cannot be undone

## Overview

The `MoveSection` and `MoveStation` commands are stub implementations that log requests but don't actually modify state. Moving a section/station appears to do nothing, and undo/redo has no effect.

## Scope

- Fix `MoveSection` command to actually modify `project.section_offsets`
- Fix `MoveStation` command to actually modify station positions via new `station_offsets` field
- Both commands should be fully reversible via undo/redo using `InverseCommand` pattern

## Root Cause

- `MoveSection` handler at `src-tauri/src/core/state/commands.rs:581-602` only logs and returns success
- `MoveStation` handler at `src-tauri/src/core/state/commands.rs:604-639` same issue
- MoveSection undo is correctly configured with `InverseCommand` pattern
- MoveStation undo uses heavy `ProjectSnapshot` - will be changed to `InverseCommand`

## Implementation Plan

### Task 1: Implement MoveSection command (fn-43-uvi.1)

**File:** `src-tauri/src/core/state/commands.rs:581-602`

**Implementation:**
```rust
pub(super) fn move_section(&self, section_id: SectionId, offset: Coordinates) -> CommandResult {
    // ... lock boilerplate ...

    if project.sections.iter().any(|s| s.id == section_id) {
        // Get current offset or default to (0.0, 0.0)
        let current = project.section_offsets.get(&section_id).copied().unwrap_or((0.0, 0.0));
        // Apply delta (2D only - z ignored per design decision)
        let new_offset = (current.0 + offset.x, current.1 + offset.y);
        project.section_offsets.insert(section_id, new_offset);
        project.touch();
        tracing::info!(?section_id, ?offset, ?new_offset, "Section moved");
        CommandResult::success()
    } else {
        CommandResult::failure("Section not found".to_string())
    }
}
```

**Undo:** Already works via `InverseCommand` at `undo.rs:242-248`.

---

### Task 2: Implement MoveStation command (fn-43-uvi.2)

**Design Decision:** Change MoveStation from absolute `new_position` to delta `offset` to match MoveSection semantics and enable proper undo via InverseCommand.

#### Step 2a: Change Command signature

**File:** `src-tauri/src/core/command.rs:92-95`

```rust
// BEFORE:
MoveStation {
    station_ref: StationRef,
    new_position: Coordinates,
},

// AFTER:
MoveStation {
    station_ref: StationRef,
    offset: Coordinates,  // Delta, not absolute position
},
```

#### Step 2b: Add station_offsets field to Project

**File:** `src-tauri/src/models/project.rs` (after line 39)

```rust
/// Station offsets (x, y, z) applied when stations are moved individually
#[serde(default)]
pub station_offsets: HashMap<StationRef, (f64, f64, f64)>,
```

Also update `Project::new()` to initialize it:
```rust
station_offsets: HashMap::new(),
```

#### Step 2c: Update coordinate calculation

**File:** `src-tauri/src/models/project.rs:828-880` (`compute_station_coordinates_with_progress`)

After computing each station's coordinates from shots, apply any station offset:

```rust
// After line 873 (where station is pushed):
let station_ref = StationRef::new(section.id, (i + 1) as u32);

// Apply station offset if exists
if let Some(&(ox, oy, oz)) = self.station_offsets.get(&station_ref) {
    current_coords = Coordinates::new(
        current_coords.x + ox,
        current_coords.y + oy,
        current_coords.z + oz,
    );
}

stations.push(Station::with_coordinates(station_ref, current_coords));
```

Also apply to first station (station 0) after line 848.

#### Step 2d: Implement move_station command

**File:** `src-tauri/src/core/state/commands.rs:604-639`

```rust
pub(super) fn move_station(&self, station_ref: StationRef, offset: Coordinates) -> CommandResult {
    // ... lock boilerplate ...

    // Validate section exists
    let section = project.sections.iter().find(|s| s.id == station_ref.section_id);
    let section = match section {
        Some(s) => s,
        None => return CommandResult::failure("Section not found".to_string()),
    };

    // Validate station index
    if station_ref.station_index > section.shots.len() as u32 {
        return CommandResult::failure("Invalid station index".to_string());
    }

    // Get current offset or default
    let current = project.station_offsets.get(&station_ref).copied().unwrap_or((0.0, 0.0, 0.0));
    // Apply delta
    let new_offset = (current.0 + offset.x, current.1 + offset.y, current.2 + offset.z);
    project.station_offsets.insert(station_ref, new_offset);
    project.touch();

    tracing::info!(?station_ref, ?offset, ?new_offset, "Station moved");
    CommandResult::success()
}
```

#### Step 2e: Update undo to use InverseCommand

**File:** `src-tauri/src/core/state/undo.rs:250-259`

```rust
// BEFORE:
Command::MoveStation { station_ref: _, new_position: _ } => {
    UndoData::ProjectSnapshot(serde_json::to_string(project).unwrap_or_default())
}

// AFTER:
Command::MoveStation { station_ref, offset } => {
    // Inverse is moving back by negative offset
    UndoData::InverseCommand(Command::MoveStation {
        station_ref: *station_ref,
        offset: Coordinates::new(-offset.x, -offset.y, -offset.z),
    })
}
```

#### Step 2f: Update persistence (if needed)

**File:** `src-tauri/src/persistence/sqlite.rs`

Add table and load/save for `station_offsets` (follow `section_offsets` pattern at lines 254, 338, 436, 647).

#### Step 2g: Update all callers

Search for `MoveStation` usage and update from `new_position` to `offset`:
- `src-tauri/src/core/command.rs:520` (display impl)
- `src-tauri/src/commands/` (Tauri IPC handlers)
- Frontend TypeScript if applicable

---

### Task 3: Add unit tests (fn-43-uvi.3)

**File:** `src-tauri/src/core/state/tests.rs`

```rust
#[test]
fn test_move_section_updates_offsets() {
    let state = AppState::new().unwrap();
    state.execute(Command::CreateProject { name: "Test".to_string(), location: None });
    let result = state.execute(Command::CreateSection { /* ... */ });
    let section_id = result.section_id.unwrap();

    // Move section
    state.execute(Command::MoveSection {
        section_id,
        offset: Coordinates::new(10.0, 20.0, 0.0),
    });

    let project = state.get_project_state().unwrap();
    assert_eq!(project.section_offsets.get(&section_id), Some(&(10.0, 20.0)));

    // Move again - should accumulate
    state.execute(Command::MoveSection {
        section_id,
        offset: Coordinates::new(5.0, -10.0, 0.0),
    });

    let project = state.get_project_state().unwrap();
    assert_eq!(project.section_offsets.get(&section_id), Some(&(15.0, 10.0)));
}

#[test]
fn test_move_section_undo() {
    // Create project/section, move, undo, verify offset restored
}

#[test]
fn test_move_section_redo() {
    // Create project/section, move, undo, redo, verify offset applied
}

#[test]
fn test_move_station_updates_offsets() {
    // Similar to section but with station_offsets
}

#[test]
fn test_move_station_undo() {
    // Verify InverseCommand properly reverses station move
}

#[test]
fn test_station_offset_applied_in_coordinates() {
    // Move station, verify compute_station_coordinates includes offset
}
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `src-tauri/src/core/command.rs:92-95` | Change `new_position` to `offset` |
| `src-tauri/src/core/command.rs:520` | Update display impl |
| `src-tauri/src/core/state/commands.rs:581-602` | Implement MoveSection |
| `src-tauri/src/core/state/commands.rs:604-639` | Implement MoveStation |
| `src-tauri/src/core/state/undo.rs:250-259` | Change to InverseCommand |
| `src-tauri/src/models/project.rs:39` | Add `station_offsets` field |
| `src-tauri/src/models/project.rs:91` | Initialize in `new()` |
| `src-tauri/src/models/project.rs:828-880` | Apply station offsets in coordinate calc |
| `src-tauri/src/persistence/sqlite.rs` | Add station_offsets table + load/save |
| `src-tauri/src/core/state/tests.rs` | Add comprehensive tests |
| `src-tauri/src/commands/*.rs` | Update Tauri IPC handlers if needed |

## Quick commands

- `cargo test --manifest-path src-tauri/Cargo.toml`
- `cargo test --manifest-path src-tauri/Cargo.toml move_section`
- `cargo test --manifest-path src-tauri/Cargo.toml move_station`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `pnpm tsc --noEmit`

## Acceptance

- [ ] MoveSection updates `project.section_offsets` HashMap
- [ ] MoveSection undo restores previous offset (via InverseCommand)
- [ ] MoveSection redo re-applies the move
- [ ] MoveStation command signature changed to use `offset` (delta)
- [ ] MoveStation updates `project.station_offsets` HashMap
- [ ] MoveStation undo restores previous offset (via InverseCommand)
- [ ] MoveStation redo re-applies the move
- [ ] Station offsets applied in `compute_station_coordinates_with_progress`
- [ ] Station offsets persisted to SQLite
- [ ] All existing tests pass
- [ ] New tests cover undo/redo for both commands
- [ ] Multiple moves accumulate correctly (don't overwrite)

## References

- `project.section_offsets` field: `src-tauri/src/models/project.rs:39`
- Coordinate calculation: `src-tauri/src/models/project.rs:828-880`
- MoveSection undo config: `src-tauri/src/core/state/undo.rs:242-248`
- MoveStation undo config: `src-tauri/src/core/state/undo.rs:250-259`
- SQLite persistence: `src-tauri/src/persistence/sqlite.rs:254` (section_offsets table)
- Existing tests: `src-tauri/src/core/state/tests.rs:1336-1378`
- StationRef type: `src-tauri/src/models/station.rs:7` (already derives Hash)
