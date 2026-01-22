# fn-19-mmx.3 Enhance undo data to capture section_offsets

## Description
Enhance `UndoData::ZeroDatumInfo` to capture `section_offsets` before modification, enabling full undo of repositioning.

**Size:** S
**Files:** `src-tauri/src/core/undo.rs`, `src-tauri/src/models/project.rs`

## Approach

1. Extend `ZeroDatumInfo` struct to include `previous_offsets: HashMap<SectionId, (f64, f64)>`
2. Before setting datum, capture current offsets for all affected sections
3. On undo, restore previous offsets from `ZeroDatumInfo`
4. On redo, reapply the computed offsets

Follow existing undo pattern at `undo.rs:72-77`.

## Key context

Current `ZeroDatumInfo` only stores `previous_gps`. After this task, it must also store the section offsets that existed before the operation, so undo can fully restore the previous state.
## Acceptance
- [ ] `ZeroDatumInfo` includes `previous_offsets: HashMap<SectionId, (f64, f64)>`
- [ ] Section offsets captured before datum set
- [ ] Undo restores previous section offsets
- [ ] Undo restores previous GPS (or removes if new datum)
- [ ] Redo reapplies datum and computed offsets
- [ ] Rust tests pass (cargo test)
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
