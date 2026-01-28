# fn-44-3sf.2 Fix CreateShot undo/redo ID preservation

## Description

Fix CreateShot command so that undo→redo preserves the original shot ID instead of assigning a new one.

**Size:** M
**Files:**
- `src-tauri/src/core/state/undo.rs` (main changes)
- `src-tauri/src/core/undo.rs` (new variant)
- `src-tauri/src/core/state/tests.rs` (new tests)

## Approach

1. **Introduce new UndoData variant** `CreatedShotSnapshot` (distinct from existing `ShotSnapshot` used by DeleteShot):
   - Add to UndoData enum in `src-tauri/src/core/undo.rs`
   - Same fields as ShotSnapshot: `{ section_id, shot_id, shot_data, position }`
   - Distinct variant prevents confusion with DeleteShot's undo handling

2. In `finalize_undo_data()` (undo.rs:315-331), change CreateShot to return `CreatedShotSnapshot`:
   - Currently returns `InverseCommand(DeleteShot{section_id, shot_id: 0})` then fills in shot_id
   - **Critical**: To capture correct shot when `after_shot_id` inserts mid-section:
     - After `add_shot()` or `insert_shot_after()`, get the returned shot reference or ID
     - Find the shot by the captured ID in `section.shots` to get its position
     - Do NOT use `section.shots.last()` - it's wrong for mid-section inserts
   - Pattern: `let shot_id = section.next_shot_id - 1;` then `section.shots.iter().position(|s| s.id == shot_id)`

3. In `undo()`, add handling for `CreatedShotSnapshot`:
   - When undoing CreateShot with `CreatedShotSnapshot`, DELETE the shot
   - Find section by section_id, find shot by shot_id, remove from section.shots

4. In `redo()`, add handling for `CreatedShotSnapshot`:
   - Match specifically on `CreatedShotSnapshot` (NOT generic ShotSnapshot)
   - Call existing `restore_shot()` with section_id, shot_id, shot_data, and position
   - `restore_shot()` at undo.rs:777-816 already handles ID preservation and position

## Key context

- **Why new variant**: Same rationale as CreatedSectionSnapshot - DeleteShot uses `ShotSnapshot` for its undo
- **Position tracking**: The shot's position in the vector must be captured at finalize time (after creation), not derived from `after_shot_id`. The `after_shot_id` is an input hint, but actual position depends on where it was inserted.
- `restore_shot()` already exists and correctly:
  - Uses `Shot::new(original_shot_id, data)` to preserve ID
  - Updates `section.next_shot_id` if needed (undo.rs:802-805)
  - Inserts at the correct position index

## Acceptance

- [ ] New UndoData::CreatedShotSnapshot variant added
- [ ] CreateShot undo→redo preserves original shot ID
- [ ] Shot position captured correctly (not via shots.last())
- [ ] Mid-section inserts (via after_shot_id) preserve correct position
- [ ] Double cycle maintains same shot ID and position
- [ ] Post-redo: can edit and delete the restored shot
- [ ] CreatedShotSnapshot distinct from ShotSnapshot (DeleteShot unaffected)
- [ ] Test: `test_create_shot_undo_redo_preserves_id`
- [ ] Test: `test_create_shot_mid_section_undo_redo_preserves_position`
- [ ] Existing shot undo tests still pass

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
