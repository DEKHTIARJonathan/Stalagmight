# fn-44-3sf.1 Fix CreateSection undo/redo ID preservation

## Description

Fix CreateSection command so that undo→redo preserves the original section ID instead of assigning a new one.

**Size:** M
**Files:**
- `src-tauri/src/core/state/undo.rs` (main changes)
- `src-tauri/src/core/undo.rs` (new variant)
- `src-tauri/src/core/state/tests.rs` (new tests)

## Approach

1. **Introduce new UndoData variant** `CreatedSectionSnapshot` (distinct from existing `SectionSnapshot` used by DeleteSection):
   - Add to UndoData enum in `src-tauri/src/core/undo.rs`
   - Same fields as SectionSnapshot: `{ section_id, section_data }`
   - Distinct variant prevents confusion with DeleteSection's undo handling

2. In `finalize_undo_data()` (undo.rs:288-313), change CreateSection to return `CreatedSectionSnapshot`:
   - Currently returns `InverseCommand(DeleteSection{section_id})`
   - Change to capture full section via `section.to_section_data()` including ID
   - Pattern: `UndoData::CreatedSectionSnapshot { section_id: section.id, section_data: section.to_section_data() }`

3. In `undo()` (undo.rs:382-425), add handling for `CreatedSectionSnapshot`:
   - When undoing CreateSection with `CreatedSectionSnapshot`, DELETE the section by section_id
   - This is the inverse of create (not restore, which is what SectionSnapshot does)
   - Pattern: find section by ID, remove from project.sections

4. In `redo()` (undo.rs:628-687), add handling for `CreatedSectionSnapshot`:
   - Match specifically on `CreatedSectionSnapshot` (NOT generic SectionSnapshot)
   - Call existing `restore_section()` with the section_id and section_data
   - `restore_section()` at undo.rs:750-774 already handles ID preservation

## Key context

- **Why new variant**: DeleteSection already uses `SectionSnapshot` for its undo (to restore on undo). If CreateSection also used `SectionSnapshot`, redo logic couldn't distinguish between:
  - Redoing CreateSection (should restore the created section)
  - Redoing DeleteSection (should delete the section)
- `restore_section()` already exists and correctly:
  - Uses `Section::new_with_id()` to preserve original ID
  - Updates `next_section_id` counter if needed (undo.rs:768-770)
  - Handles shots within section

## Acceptance

- [ ] New UndoData::CreatedSectionSnapshot variant added
- [ ] CreateSection undo→redo preserves original section ID
- [ ] Double cycle (create→undo→redo→undo→redo) maintains same ID
- [ ] Section with shots: all shot IDs preserved through cycle
- [ ] Post-redo: can edit and delete the restored section
- [ ] CreatedSectionSnapshot distinct from SectionSnapshot (DeleteSection unaffected)
- [ ] Test: `test_create_section_undo_redo_preserves_id`
- [ ] Test: `test_create_section_double_undo_redo_cycle`
- [ ] Existing undo tests still pass (DeleteSection behavior unchanged)

## Done summary
Added UndoData::CreatedSectionSnapshot variant and updated finalize_undo_data, undo, and redo to use snapshot-based restoration for CreateSection. This preserves the original section ID (and all shot IDs) through undo/redo cycles instead of assigning new IDs. Added 6 tests covering single cycle, double cycle, post-redo edit/delete, variant distinction, and DeleteSection regression.
## Evidence
- Commits: 37cd58a, 5742b5e
- Tests: cargo test --manifest-path src-tauri/Cargo.toml (80 passed), cargo test --manifest-path src-tauri/Cargo.toml -- undo (88 passed)
- PRs: