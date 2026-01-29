## Description

Compound command that deletes the last remaining shot in a section and removes the empty section. Uses `ProjectSnapshotPair` for single-undo. Also cleans up all section references (merges, closures, offsets).

## Files to Modify
- `src-tauri/src/core/state/commands.rs` — Add `execute_delete_last_shot_and_section()` method
- `src-tauri/src/commands/shot.rs` — Add `delete_last_shot_and_section` Tauri command
- `src-tauri/src/lib.rs` — Register new command
- `src/store/projectStore.ts` — Add `deleteLastShotAndSection()` store method

## Implementation Details

### Compound command (`commands.rs`)

Follow the `execute_create_and_merge()` pattern — compound operation bypassing `execute()`:

```rust
pub fn execute_delete_last_shot_and_section(
    &self, section_id: SectionId, shot_id: ShotId,
) -> CommandResult
```

Key steps:
1. Take BEFORE snapshot (full project JSON)
2. Verify section has exactly 1 shot and it matches `shot_id`
3. Remove shot from section
4. **Call `project.cleanup_section_references(section_id)`** — removes orphaned merges, closures, section_offsets, station_offsets (this method is added in Task 7; if implementing Task 4 before Task 7, add the cleanup inline or stub it)
5. Remove section via `project.remove_section(section_id)`
6. Take AFTER snapshot
7. Push single undo entry with `Command::Batch` and `UndoData::ProjectSnapshotPair { before, after }`

**IMPORTANT**: Must call `cleanup_section_references()` (from Task 7) to satisfy the epic requirement "section deletion cleans up orphaned merges/closures/offsets". If Task 7 hasn't been implemented yet, add the cleanup logic inline (retain merges, closures, remove offsets) or add a TODO that Task 7 will provide the helper.

### Tauri command (`shot.rs`)
Signature: `delete_last_shot_and_section(state, section_id, shot_id) -> CommandResult`
Calls `state.execute_delete_last_shot_and_section(section_id, shot_id)` directly (NOT through `execute()`).

### Frontend store (`projectStore.ts`)
Add `deleteLastShotAndSection(sectionId, shotId)` — invokes Tauri command, refreshes state, sets dirty flag.

## Tests
- `test_delete_last_shot_removes_section` — 1-shot section → shot and section removed
- `test_delete_last_shot_fails_if_multiple_shots` — 2-shot section returns failure
- `test_delete_last_shot_undo_restores` — Undo restores section with its shot
- `test_delete_last_shot_cleans_up_offsets` — Section offsets removed
- `test_delete_last_shot_cleans_up_merges` — Merges referencing deleted section removed
- `test_delete_last_shot_cleans_up_station_offsets` — Station offsets referencing deleted section removed

## Acceptance
- [ ] Deleting last shot removes both shot and section
- [ ] Fails if section has more than 1 shot
- [ ] **All section references cleaned up**: merges, closures, section_offsets, station_offsets
- [ ] Single undo restores section with shot and all references
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
