## Description

New Rust compound command that deletes a mid-section shot and splits the section into two, with user-provided names. Uses `ProjectSnapshotPair` for single-undo. Follows `execute_create_and_merge()` pattern in `commands.rs`.

**Interview clarifications:**
- Full merge/closure/offset remapping during split
- Recalculate offset for section B (not just copy from original)
- Post-split: frontend selects section A (first half) — section A keeps the original section ID
- Both sections inherit all metadata (name, surveyor, date, color, direction). **Note**: `Section`/`SectionData` do NOT have a `comment` field — do not attempt to copy it.

## Files to Modify
- `src-tauri/src/models/section.rs` — Add `split_shots_at(shot_id)` helper
- `src-tauri/src/core/state/commands.rs` — Add `execute_delete_shot_and_split()` method (compound operation, manages its own undo data like `execute_create_and_merge`)
- `src-tauri/src/core/command.rs` — Use `Command::Batch` for undo history
- `src-tauri/src/commands/shot.rs` — Add `delete_shot_and_split` Tauri command
- `src-tauri/src/lib.rs` — Register command
- `src/store/projectStore.ts` — Add `deleteShotAndSplit()` store method

## Implementation Details

### Section model helper (`section.rs`)
Add `split_shots_at` method signature:
```rust
pub fn split_shots_at(&self, shot_id: ShotId) -> Option<(usize, Vec<ShotData>, Vec<ShotData>)>
```
Returns `(position, shots_before, shots_after)` excluding the target shot. Returns `None` if shot is first/last (edge shots don't split).

### Compound command (`commands.rs`)
Follow the `execute_create_and_merge()` pattern — this is a compound operation that bypasses `execute()` and manages its own undo data:

```rust
pub fn execute_delete_shot_and_split(
    &self, section_id: SectionId, shot_id: ShotId, name_a: String, name_b: String,
) -> CommandResult
```

Key steps:
1. Take BEFORE snapshot (full project JSON)
2. Get split data: `split_shots_at()` result, **capture deleted shot data** for offset calculation, copy metadata fields (surveyor, date, color, direction — **NOT comment**, it doesn't exist on Section)
3. Modify original section → section A: set name, replace shots with `shots_before`
4. Create section B: use `project.add_section(data)` (the existing method, **NOT** `create_section_internal` which doesn't exist). To avoid double-pushing undo data, call `add_section` directly on the `Project` model rather than going through `execute()`.
5. **Recalculate offset for section B** using `Shot::average_azimuth()` (handles wraparound correctly, see `project.rs:347`). Walk `shots_before` + deleted shot using their `average_azimuth()` values:
   ```rust
   let azimuth_rad = shot.average_azimuth().to_radians();
   bx += shot.length * azimuth_rad.sin();
   by += shot.length * azimuth_rad.cos();
   ```
6. Remap merge/closure/station_offset references: stations after split point belong to new section with adjusted indices
7. Take AFTER snapshot
8. Push single undo entry with `UndoData::ProjectSnapshotPair { before, after }`

### Important: Capture deleted shot data in step 2
The deleted shot's geometry is needed for offset calculation but is removed during the split. Capture it before modification:
```rust
let deleted_shot_data = section.shots[pos].to_shot_data();
```

### Tauri command (`shot.rs`)
Signature: `delete_shot_and_split(state, section_id, shot_id, name_a, name_b) -> CommandResult`

### Frontend store (`projectStore.ts`)
Add `deleteShotAndSplit(sectionId, shotId, nameA, nameB)` — invokes the Tauri command, refreshes state, sets dirty flag.

## Tests
- `test_split_section_basic` — 5-shot section split at index 2 → A has 2 shots, B has 2 shots
- `test_split_preserves_metadata` — Both sections have original surveyor, date, color, direction (no comment field to check)
- `test_split_recalculates_offset_b` — Section B offset uses `average_azimuth()` for accumulated shot geometry
- `test_split_remaps_merges` — Merge with station_index > split_pos remapped to new section
- `test_split_remaps_closures` — Loop closure stations remapped correctly
- `test_split_remaps_station_offsets` — Individual station moves remapped
- `test_split_undo_restores_original` — Undo restores single section, all references intact
- `test_split_redo_resplits` — Redo produces identical split
- `test_split_rejects_edge_shot` — Returns failure for first/last shot

## Acceptance
- [ ] Mid-section shot deletion splits into two named sections
- [ ] Both sections inherit original metadata (surveyor, date, color, direction — no comment)
- [ ] Section B offset recalculated using `Shot::average_azimuth()` for accumulated shot geometry
- [ ] All merges/closures/station_offsets remapped to correct section + index
- [ ] Single undo restores original section with all references
- [ ] Edge shots rejected
- [ ] Uses `project.add_section()` (not nonexistent `create_section_internal`)
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes

## Done summary
Implemented delete-shot-and-split-section compound backend command with ProjectSnapshotPair undo, section B offset calculation, station reference remapping, and 9 integration tests. Fixed review feedback: TS interface, shot ID preservation, distinct error messages, descriptive undo history.
## Evidence
- Commits: 8d9bea3e5210b9273cbd63747f19dbd132845b3a
- Tests: cargo test --manifest-path src-tauri/Cargo.toml, pnpm tsc --noEmit
- PRs: