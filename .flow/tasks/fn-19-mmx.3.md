# fn-19-mmx.3 Enhance undo data to capture section_offsets

## Description
Enhance undo for SetZeroDatum to capture and restore `section_offsets` directly, rather than re-calling set_zero_datum/remove_zero_datum.

**Size:** M
**Files:** `src-tauri/src/core/undo.rs`, `src-tauri/src/core/state.rs`

## Approach

**Part 1: Enhance UndoData (undo.rs)**
Extend `ZeroDatumInfo` struct:
- `previous_gps: Option<GpsCoordinates>` (existing)
- `previous_offsets: HashMap<SectionId, Option<(f64, f64)>>` (NEW - None means key didnt exist)

**Part 2: Update undo handler (state.rs)**
Before executing SetZeroDatum:
1. Capture current offsets for all sections that will be affected
2. Track which offset keys existed vs didnt exist (for clean removal on undo)

On undo:
1. Restore `section_offsets` directly from `previous_offsets`
2. Remove keys that were newly created (where previous was None)
3. Restore or remove GPS from `zero_datums` vector
4. Do NOT call `set_zero_datum` - this would recompute offsets

On redo:
1. Re-execute the command normally (it will compute fresh offsets)

## Key context

Current undo for SetZeroDatum in state.rs calls `set_zero_datum`/`remove_zero_datum`, which after our changes would recompute offsets instead of restoring exact previous state.

## Acceptance
- [ ] `ZeroDatumInfo` includes `previous_offsets: HashMap<SectionId, Option<(f64, f64)>>`
- [ ] Section offsets captured before datum set (in state.rs)
- [ ] Undo restores exact previous section offsets (not recomputed)
- [ ] Undo removes newly-created offset keys
- [ ] Undo restores previous GPS (or removes if new datum)
- [ ] Undo handler in state.rs does NOT call set_zero_datum
- [ ] Redo re-executes command normally
- [ ] Rust tests pass (cargo test)

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
