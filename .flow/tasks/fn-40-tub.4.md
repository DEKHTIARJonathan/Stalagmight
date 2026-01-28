# fn-40-tub.4 Tests and SPEC.md documentation updates

## Description

Add/update tests for the new merge/closure separation and update SPEC.md documentation to reflect the changed commands, dialogs, and workflow.

**Size:** M
**Files:**
- `src-tauri/src/models/project/tests.rs` — tests for `create_loop_closure()`, connectivity check, duplicate prevention, same-section closure
- `src-tauri/src/core/state/tests.rs` — undo/redo tests for `CreateLoopClosure`
- `src-tauri/src/core/undo.rs` (test section) — update serialization tests for new `ClosureInfo` variant, update `MergeInfo` tests (strategy removed)
- `tests/` (Playwright) — E2E tests for dialog flows
- `docs/SPEC.md` — update command enum, dialog descriptions, workflow, UndoData variants

## Approach

### 1. Rust unit tests

**Project model tests** (`src-tauri/src/models/project/tests.rs`):
- Test `create_loop_closure()` creates correct LoopClosure with calculated values
- Test `create_loop_closure()` rejects duplicate closure (same station pair)
- Test `create_loop_closure()` allows same-section closures
- Test `create_loop_closure()` rejects unconnected stations
- Test `merge_stations()` now rejects already-connected stations (returns Err)
- Test `unmerge_stations()` also removes closures involving the station

**Undo/redo tests** (`src-tauri/src/core/state/tests.rs`):
- Test CreateLoopClosure → undo removes closure → redo re-adds it
- Test undo stack entry has correct `ClosureInfo` data

**Serialization tests** (`src-tauri/src/core/undo.rs` test section):
- Update `test_undo_data_merge_info` to reflect removed `strategy` field
- Add test for `UndoData::ClosureInfo` serialization/deserialization
- Update any integration test fixtures that reference `MergeStations` with `closure_strategy`

### 2. Playwright E2E tests

- Test merge flow: select two unconnected stations → MergeDialog appears (no closure info) → confirm → stations merged
- Test closure flow: select two connected stations → ClosureDialog appears with preview data → confirm → closure created
- Test undo closure: create closure → undo → closure line removed from map
- Test duplicate prevention: try to merge already-merged stations → error shown

### 3. SPEC.md updates

Update these sections in `docs/SPEC.md`:
- **Command enum section**: Remove `closure_strategy` from `MergeStations`, add `CreateLoopClosure { station_a, station_b, closure_strategy }` variant
- **UndoData section**: Remove `strategy` from `MergeInfo`, add `ClosureInfo` variant
- **Dialog section**: Update MergeDialog description (simpler), add ClosureDialog description
- **Workflow section**: Update merge/closure user flow to reflect connectivity check → appropriate dialog → appropriate command
- **Visual indicators**: Remove any reference to merge lines / survey-merges layer
- **Component list**: Add `ClosureDialog.tsx`
## Acceptance
- [ ] Rust tests: `create_loop_closure()` creates correct LoopClosure
- [ ] Rust tests: duplicate closure rejected
- [ ] Rust tests: same-section closure allowed
- [ ] Rust tests: `merge_stations()` rejects connected stations
- [ ] Rust tests: `unmerge_stations()` removes closures
- [ ] Rust tests: CreateLoopClosure undo/redo works correctly
- [ ] Rust tests: ClosureInfo serialization/deserialization
- [ ] Rust tests: MergeInfo without strategy field
- [ ] E2E tests: merge flow (unconnected stations → MergeDialog → merge)
- [ ] E2E tests: closure flow (connected stations → ClosureDialog → closure)
- [ ] SPEC.md Command enum updated (MergeStations without strategy, CreateLoopClosure added)
- [ ] SPEC.md UndoData updated (MergeInfo without strategy, ClosureInfo added)
- [ ] SPEC.md dialog descriptions updated
- [ ] SPEC.md workflow updated
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] `pnpm test:ui` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
