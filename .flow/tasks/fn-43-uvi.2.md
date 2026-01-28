# fn-43-uvi.2 Implement MoveStation command

## Description

Properly implement MoveStation command with delta-based offset (matching MoveSection semantics).

### Changes Required

1. **Change Command signature** (`src-tauri/src/core/command.rs:92-95`):
   - Rename `new_position` to `offset` (delta, not absolute)

2. **Add station_offsets field** (`src-tauri/src/models/project.rs`):
   ```rust
   #[serde(default)]
   pub station_offsets: HashMap<StationRef, (f64, f64, f64)>,
   ```

3. **Update coordinate calculation** (`src-tauri/src/models/project.rs:828-880`):
   - Apply station offsets after computing position from shots

4. **Implement move_station** (`src-tauri/src/core/state/commands.rs:604-639`):
   - Get current offset or default (0,0,0)
   - Add delta offset
   - Store in station_offsets HashMap

5. **Update undo** (`src-tauri/src/core/state/undo.rs:250-259`):
   - Change from ProjectSnapshot to InverseCommand with negated offset
   - Also add MoveStation to `execute_without_undo` match (~undo.rs:746-747), following the MoveSection pattern at line 746: `Command::MoveStation { station_ref, offset } => self.move_station(*station_ref, *offset),`
   <!-- Updated by plan-sync: fn-43-uvi.1 required adding MoveSection to execute_without_undo for InverseCommand to work; MoveStation will need the same -->

6. **Add persistence** (`src-tauri/src/persistence/sqlite.rs`):
   - Add station_offsets table (follow section_offsets pattern)

7. **Update callers**:
   - Update display impl, Tauri IPC handlers, frontend if needed

## Acceptance

- [ ] MoveStation command signature changed to `offset: Coordinates`
- [ ] `station_offsets` field added to Project model
- [ ] `station_offsets` initialized in Project::new()
- [ ] Station offsets applied in compute_station_coordinates_with_progress
- [ ] move_station command accumulates offsets correctly
- [ ] Undo uses InverseCommand with negated offset
- [ ] station_offsets persisted to SQLite
- [ ] All callers updated for new signature

## Done summary
Implemented MoveStation command with delta-based offset semantics matching MoveSection. Changed command signature from absolute new_position to delta offset, added station_offsets HashMap to Project model with custom serde, applied station offsets in both compute_station_coordinates_with_progress and compute_station_raw_coords, switched undo from ProjectSnapshot to InverseCommand, added SQLite persistence, and updated all callers including frontend.
## Evidence
- Commits: ed97358, 68d8b62
- Tests: cargo test --manifest-path src-tauri/Cargo.toml, pnpm tsc --noEmit
- PRs: