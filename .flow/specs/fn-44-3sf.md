# Fix undo/redo ID preservation for entity creation commands

## Overview

When entities (sections, shots) are created, undone, then redone, they get NEW IDs instead of their original IDs. This breaks the undo/redo stack because subsequent operations reference the original ID.

**Root cause**: `redo()` re-executes the original `CreateSection`/`CreateShot` commands, which call `add_section()`/`add_shot()` using the current monotonic counter. After undo, the counter has moved past the original ID.

**Fix approach**: Introduce new `CreatedSectionSnapshot` and `CreatedShotSnapshot` undo data variants (distinct from existing `SectionSnapshot`/`ShotSnapshot` used by Delete commands). On redo, restore from snapshot with original ID instead of re-executing the command.

## Scope

**In scope**:
- CreateSection undo/redo ID preservation (new CreatedSectionSnapshot variant)
- CreateShot undo/redo ID preservation (new CreatedShotSnapshot variant)
- CreateLoopClosure audit (verify if affected)
- Compound commands verification (create_section_and_merge already uses ProjectSnapshotPair)

**Out of scope** (do not exist in codebase):
- ~~CreateSystem~~ - command doesn't exist
- ~~CreateSurvey~~ - command doesn't exist

## Approach

**Why new UndoData variants?** DeleteSection/DeleteShot already use `SectionSnapshot`/`ShotSnapshot` for their undo (to restore on undo). Using the same variants for CreateSection/CreateShot would make redo ambiguous - can't distinguish "redo create" (restore) from "redo delete" (delete). New variants solve this.

For CreateSection:
1. Add `UndoData::CreatedSectionSnapshot { section_id, section_data }` variant
2. Change `finalize_undo_data` to return `CreatedSectionSnapshot` (currently returns `InverseCommand(DeleteSection)`)
3. In `undo()`, handle `CreatedSectionSnapshot` by deleting the section
4. In `redo()`, handle `CreatedSectionSnapshot` by calling `restore_section()`

For CreateShot:
1. Add `UndoData::CreatedShotSnapshot { section_id, shot_id, shot_data, position }` variant
2. Change `finalize_undo_data` to return `CreatedShotSnapshot` with correct position (capture by ID, not last())
3. In `undo()`, handle `CreatedShotSnapshot` by deleting the shot
4. In `redo()`, handle `CreatedShotSnapshot` by calling `restore_shot()`

Leverage existing functions:
- `restore_section()` at `undo.rs:750-774` - already restores section with specific ID
- `restore_shot()` at `undo.rs:777-816` - already restores shot with specific ID and position

## Quick commands

```bash
# Run Rust tests
cargo test --manifest-path src-tauri/Cargo.toml

# Specific undo tests
cargo test --manifest-path src-tauri/Cargo.toml undo

# Type check frontend (no frontend changes expected)
pnpm tsc --noEmit
```

## Risks

| Risk | Mitigation |
|------|------------|
| Merge conflict with fn-43-uvi (both touch undo.rs) | Different sections of file - coordinate timing |
| New variants add complexity | Follows same pattern as existing SectionSnapshot/ShotSnapshot |
| Shot position tracking | Capture position by finding shot ID after insert, not using last() |

## Acceptance

- [x] UndoData has new CreatedSectionSnapshot and CreatedShotSnapshot variants
- [x] CreateSection undo→redo preserves original section ID
- [x] CreateShot undo→redo preserves original shot ID
- [x] Double undo/redo cycle maintains ID stability
- [x] Mid-section shot inserts preserve correct position
- [x] Post-redo operations work (can edit/delete restored entity)
- [x] Rust unit tests cover undo→redo→undo→redo cycle
- [x] DeleteSection/DeleteShot behavior unchanged (still use SectionSnapshot/ShotSnapshot)
- [x] CreateLoopClosure audited (document if affected)
- [x] create_section_and_merge verified working (already uses ProjectSnapshotPair)

## Audit Results (fn-44-3sf.3)

### CreateLoopClosure - NOT AFFECTED
Loop closures are identified by station pairs (StationRef, StationRef), not by monotonic IDs.
- `finalize_undo_data` captures `ClosureInfo { closure }` with the full `LoopClosure` struct.
- Undo removes the closure by matching station pairs.
- Redo re-executes `CreateLoopClosure` which creates a closure with the same station pair.
- Identity is the station pair itself, so redo inherently preserves identity.

### create_section_and_merge - IDs PRESERVED via ProjectSnapshotPair
- Takes full project snapshot BEFORE operation (`before`).
- Takes full project snapshot AFTER operation (`after`).
- Pushes `UndoData::ProjectSnapshotPair { before, after }` to undo stack.
- Undo restores `before` snapshot (complete project state).
- Redo restores `after` snapshot (complete project state with original IDs).
- Snapshot approach inherently preserves all entity IDs.

### Batch command - UNDO preserved via ProjectSnapshot; REDO re-executes (ID caveat)
- `generate_undo_data` captures `ProjectSnapshot` of entire project before execution.
- Undo restores full project state from snapshot, preserving all entity IDs.
- Redo falls through to `execute_without_undo`, which has no `Batch` arm and
  returns failure. Even if it were added, re-execution would assign new IDs to
  any entities created within the batch.
- **Note**: If Batch must support ID-stable redo, it would need to be changed to
  `ProjectSnapshotPair` (like `create_section_and_merge`). Currently Batch redo
  is a pre-existing limitation, not introduced by this epic.

## References

- `src-tauri/src/core/state/undo.rs` - main undo/redo logic
- `src-tauri/src/core/undo.rs` - UndoStack, UndoData types
- `src-tauri/src/models/section.rs:135` - Section::new_with_id
- `src-tauri/src/models/shot.rs:110` - Shot::new(id, data)
