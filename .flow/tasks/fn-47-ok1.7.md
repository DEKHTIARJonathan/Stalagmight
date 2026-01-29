## Description

Fix pre-existing bug: section deletion leaves orphaned merges, closures, and offsets. Add cleanup logic to the backend and enhance the ConfirmDialog to show affected relationships before deletion.

## Pre-existing Bug

When a section is deleted via `project.remove_section(section_id)` (project.rs:178-182), only the section itself is removed from `self.sections`. These structures are NOT cleaned up:
- `station_merges` — StationMerge entries referencing the deleted section
- `loop_closures` — LoopClosure entries referencing the deleted section
- `section_offsets` — HashMap entry for the deleted section ID
- `station_offsets` — HashMap entries where StationRef.section_id matches

## Files to Modify

### Backend
- `src-tauri/src/models/project.rs` — Add `cleanup_section_references(section_id)` method + `get_section_relationships(section_id)` query method
- `src-tauri/src/core/state/commands.rs` — Update `delete_section()` to call `cleanup_section_references()` before `remove_section()`
- `src-tauri/src/core/state/undo.rs` — Change `generate_undo_data` for `DeleteSection` to `ProjectSnapshotPair`; add `finalize_undo_data` branch for `DeleteSection`
- `src-tauri/src/commands/history.rs` — Update `derive_preview_data` to handle `ProjectSnapshotPair` for `DeleteSection`; update test
- `src-tauri/src/commands/section.rs` — Add `get_section_relationships` Tauri command
- `src-tauri/src/lib.rs` — Register `get_section_relationships` command

### Frontend
- `src/components/Dialogs/ConfirmDialog.tsx` — Show affected relationships for section deletion
- `src/store/projectStore.ts` — Add `getSectionRelationships()` store method

## Implementation Details

### Backend: Project model (`project.rs`)

#### Query method
Signature: `pub fn get_section_relationships(&self, section_id: SectionId) -> SectionRelationships`
Returns a struct with: merges (Vec<StationMerge>), closures (Vec<LoopClosure>), has_section_offset (bool), station_offset_count (usize).

#### Cleanup method
Signature: `pub fn cleanup_section_references(&mut self, section_id: SectionId)`
Removes all merges, closures, section_offsets, and station_offsets referencing the given section.

### Backend: Core `delete_section()` (commands.rs line ~283)

Add cleanup call with existence guard:
```rust
pub(super) fn delete_section(&self, section_id: SectionId) -> CommandResult {
    let mut proj_guard = ...;
    let project = ...;
    // Only clean up if the section actually exists
    if project.get_section(section_id).is_some() {
        project.cleanup_section_references(section_id);
        project.remove_section(section_id);
        tracing::info!(section_id, "Section deleted (with cleanup)");
        CommandResult::success()
    } else {
        CommandResult::failure(format!("Section {} not found", section_id))
    }
}
```
The existence guard ensures cleanup doesn't mutate state when the section doesn't exist.

### Backend: Undo architecture (stays within `execute()` flow)

**Step 1: `generate_undo_data` (undo.rs line ~28)**
Change `Command::DeleteSection` to capture full project snapshot:
```rust
Command::DeleteSection { .. } => {
    match serde_json::to_string(project) {
        Ok(before) => UndoData::ProjectSnapshotPair {
            before,
            after: String::new(), // Filled by finalize_undo_data
        },
        Err(_) => UndoData::None,
    }
}
```

**Step 2: `finalize_undo_data` (undo.rs line ~282)**
Add `Command::DeleteSection` branch to fill in `after` snapshot:
```rust
Command::DeleteSection { .. } => {
    if let UndoData::ProjectSnapshotPair { before, .. } = undo_data {
        match serde_json::to_string(project) {
            Ok(after) => UndoData::ProjectSnapshotPair { before, after },
            Err(_) => UndoData::None,
        }
    } else {
        undo_data
    }
}
```

### Backend: History preview (history.rs line ~299) — MUST UPDATE

The `derive_preview_data` function currently matches `(DeleteSection, SectionSnapshot)`. Since we're switching to `ProjectSnapshotPair`, update this:

```rust
// DeleteSection - extract section info from ProjectSnapshotPair before snapshot
(Command::DeleteSection { section_id }, UndoData::ProjectSnapshotPair { before, .. }) => {
    // Parse the "before" snapshot to find the deleted section's data
    if let Ok(project) = serde_json::from_str::<Project>(before) {
        if let Some(section) = project.get_section(*section_id) {
            Some(PreviewData {
                changes: vec![
                    FieldChange {
                        field: "name".to_string(),
                        old_value: section.name.clone().unwrap_or_else(|| "unnamed".to_string()),
                        new_value: String::new(),
                    },
                    FieldChange {
                        field: "shots".to_string(),
                        old_value: section.shots.len().to_string(),
                        new_value: "0".to_string(),
                    },
                ],
                additional_changes: 0,
            })
        } else {
            None
        }
    } else {
        None
    }
}
```

**Note**: Parsing a full project snapshot for preview is heavier than reading from `SectionSnapshot`, but it only happens when the user opens the history panel. This is acceptable.

### Tests to update

1. **`test_entry_to_history_item_without_timestamp`** (history.rs:447): Change `UndoData::SectionSnapshot` to `UndoData::ProjectSnapshotPair`. Must construct a valid project JSON with a section that has the expected name/shots.

2. **`test_create_section_created_snapshot_distinct_from_section_snapshot`** (state/tests.rs:3838): Change assertion to expect `ProjectSnapshotPair` instead of `SectionSnapshot`.

3. **`test_delete_section_undo_redo_still_works`** (state/tests.rs:3887): Should still pass since `ProjectSnapshotPair` undo/redo restores full state.

### Backend: Tauri command (`section.rs`)
- Keep existing `delete_section` command unchanged — it calls `state.execute(Command::DeleteSection { section_id })`
- Add: `get_section_relationships(state, section_id) -> Result<SectionRelationships, String>`

### Frontend: Enhanced ConfirmDialog
When `type === 'section'`, fetch relationships via `invoke('get_section_relationships', { sectionId })` on mount. Display affected items in the dialog body. If no relationships, show standard message only.

### Frontend types
Add `SectionRelationships` interface to `src/types/project.ts` or `src/types/commands.ts`.

### Backend: `CommandResult` constructor for `create_shot` (Task 1 support)

While not this task's primary responsibility, note that Task 1 adds `shot_id: Option<ShotId>` to `CommandResult`. When `create_shot` returns via `success_with_warnings`, the `shot_id` must also be set. Task 1 should add a constructor like `success_with_shot_id(shot_id)` and ensure `success_with_warnings` can also carry `shot_id`. This is documented here for cross-task awareness.

## Tests
- Rust unit test: `test_cleanup_removes_merges` — verify merges removed after cleanup
- Rust unit test: `test_cleanup_removes_closures` — verify closures removed
- Rust unit test: `test_cleanup_removes_offsets` — verify section_offsets and station_offsets removed
- Rust unit test: `test_delete_section_undo_restores_relationships` — undo restores merges + closures
- Rust unit test: `test_get_section_relationships` — correct filtering
- Rust unit test: `test_cleanup_guarded_by_existence` — cleanup doesn't mutate when section doesn't exist
- Update: `test_entry_to_history_item_without_timestamp` — use `ProjectSnapshotPair` with valid project JSON
- Update: `test_create_section_created_snapshot_distinct_from_section_snapshot` — expect `ProjectSnapshotPair`

## Acceptance
- [ ] `delete_section()` calls `cleanup_section_references()` — cleanup in ALL code paths
- [ ] Cleanup guarded by section existence check (no mutation on missing section)
- [ ] `generate_undo_data` for `DeleteSection` captures `ProjectSnapshotPair`
- [ ] `finalize_undo_data` for `DeleteSection` fills in `after` snapshot
- [ ] `derive_preview_data` in `history.rs` handles `ProjectSnapshotPair` for `DeleteSection`
- [ ] History test `test_entry_to_history_item_without_timestamp` updated
- [ ] Undo test `test_create_section_created_snapshot_distinct_from_section_snapshot` updated
- [ ] Stays in standard `execute()` flow — no bypass, no double-push
- [ ] `get_section_relationships` Tauri command returns affected relationships
- [ ] ConfirmDialog shows affected relationships for section deletion
- [ ] Undo restores all cleaned-up relationships
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] `pnpm tsc --noEmit` passes
