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
Enhanced SetZeroDatum undo to capture and restore section_offsets directly, ensuring exact previous state is restored instead of recomputing offsets. Added previous_offsets HashMap to ZeroDatumInfo, updated undo handler to restore offsets and datum GPS without calling set_zero_datum, and added comprehensive test for offset restoration including key removal.
## Evidence
- Commits: cc865e42d5cbc8ab6d74a45c0ac8c04b76c0a51b, ccb58b9ad5b8e2f8f57cfa83102eb65dbed4cb07
- Tests: cargo test --manifest-path src-tauri/Cargo.toml, cargo test test_undo_set_zero_datum_restores_section_offsets
- PRs: