# fn-40-tub.4 Tests and SPEC.md documentation updates

## Description

Add/update tests for the new merge/closure separation and update SPEC.md documentation to reflect the changed commands, dialogs, and workflow.

**Size:** M
**Files:**
- `src-tauri/src/models/project/tests.rs` — tests for `create_loop_closure()`, connectivity check, duplicate prevention, same-section closure
- `src-tauri/src/core/state/tests.rs` — undo/redo tests for `CreateLoopClosure`
- `src-tauri/src/core/undo.rs` (test section) — add serialization test for new `ClosureInfo` variant (MergeInfo test already updated by fn-40-tub.1)
- `e2e-playwright/` — E2E tests for dialog flows
- `docs/SPEC.md` — update command enum, dialog descriptions, workflow, UndoData variants

## Approach

### 1. Rust unit tests

**Project model tests** (`src-tauri/src/models/project/tests.rs`):
- Test `create_loop_closure()` creates correct LoopClosure with calculated values
- Test `create_loop_closure()` rejects duplicate closure (same station pair)
- Test `create_loop_closure()` allows same-section closures
- Test `create_loop_closure()` rejects unconnected stations
- Test `merge_stations()` now rejects already-connected stations (returns Err)
- Test `unmerge_stations()` removes closures for the specific unmerged pair only
- Test `unmerge_stations()` does NOT remove unrelated closures involving those stations with other partners

**Undo/redo tests** (`src-tauri/src/core/state/tests.rs`):
- Test CreateLoopClosure → undo removes closure → redo re-adds it
- Test undo stack entry has correct `ClosureInfo` data
- Test UnmergeStations undo restores both the merge and the removed closures

**Serialization tests** (`src-tauri/src/core/undo.rs` test section):
<!-- Updated by plan-sync: fn-40-tub.3 — test_undo_data_merge_info was already updated by fn-40-tub.1 (strategy removed, removed_closures added). No integration fixtures reference closure_strategy for MergeStations. -->
- `test_undo_data_merge_info` already reflects removed `strategy` field and added `removed_closures` field (done in fn-40-tub.1) — no update needed
- Add test for `UndoData::ClosureInfo` serialization/deserialization

### 2. Playwright E2E tests (in `e2e-playwright/`)

- Test merge flow: select two unconnected stations → MergeDialog appears (no closure info) → confirm → stations merged
- Test closure flow: select two connected stations → ClosureDialog appears with preview data → confirm → closure created
- Test undo closure: create closure → undo → closure line removed from map
- Test duplicate prevention: try to merge already-merged stations → error shown

### 3. SPEC.md updates

Update these sections in `docs/SPEC.md`:
- **Command enum section**: Remove `closure_strategy` from `MergeStations`, add `CreateLoopClosure { station_a, station_b, closure_strategy }` variant
- **UndoData section**: Remove `strategy` from `MergeInfo`, add `removed_closures` to `MergeInfo`, add `ClosureInfo` variant
- **Dialog section**: Update MergeDialog description (simpler), add ClosureDialog description
- **Workflow section**: Update merge/closure user flow to reflect connectivity check → appropriate dialog → appropriate command
- **Visual indicators**: Remove any reference to merge lines / survey-merges layer (note: SPEC.md has no such references as of fn-40-tub.3 — verify and skip if confirmed)
<!-- Updated by plan-sync: fn-40-tub.3 removed the survey-merges layer from code; SPEC.md never referenced it -->
- **Component list**: Add `ClosureDialog.tsx`

## Acceptance
- [ ] Rust tests: `create_loop_closure()` creates correct LoopClosure
- [ ] Rust tests: duplicate closure rejected
- [ ] Rust tests: same-section closure allowed
- [ ] Rust tests: `merge_stations()` rejects connected stations
- [ ] Rust tests: `unmerge_stations()` removes closures for the specific pair only
- [ ] Rust tests: `unmerge_stations()` preserves unrelated closures
- [ ] Rust tests: CreateLoopClosure undo/redo works correctly
- [ ] Rust tests: UnmergeStations undo restores removed closures
- [ ] Rust tests: ClosureInfo serialization/deserialization
- [ ] Rust tests: MergeInfo without strategy, with removed_closures (already done by fn-40-tub.1 — verify existing test at undo.rs:778 is correct)
- [ ] E2E tests in `e2e-playwright/`: merge flow (unconnected stations → MergeDialog → merge)
- [ ] E2E tests in `e2e-playwright/`: closure flow (connected stations → ClosureDialog → closure)
- [ ] SPEC.md Command enum updated (MergeStations without strategy, CreateLoopClosure added)
- [ ] SPEC.md UndoData updated (MergeInfo without strategy + removed_closures, ClosureInfo added)
- [ ] SPEC.md dialog descriptions updated
- [ ] SPEC.md workflow updated
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] `pnpm test:ui` passes

## Done summary
## fn-40-tub.4 Summary: Merge/Closure Test Gaps & Spec Alignment

### Rust Unit Tests (project model)
- `create_loop_closure_creates_correct_values`: Verifies LoopClosure fields (path_length, misclosure_distance, error_percentage, horizontal/vertical misclosure)
- `create_loop_closure_rejects_duplicate`: Ensures duplicate and reversed duplicate closures are rejected
- `create_loop_closure_allows_same_section`: Validates same-section closures are allowed (unlike merges)
- `create_loop_closure_rejects_unconnected_stations`: Validates error when stations are not connected
- `merge_stations_rejects_already_connected`: Ensures already-connected sections can't be merged again
- `unmerge_stations_removes_closures_for_pair_only`: Verifies selective closure removal
- `unmerge_stations_preserves_unrelated_closures`: Verifies closures from other pairs remain

### Undo/Redo Tests (state)
- `test_undo_create_loop_closure`: Full undo/redo cycle for CreateLoopClosure
- `test_undo_create_loop_closure_has_closure_info`: Verifies ClosureInfo undo data is captured
- `test_undo_unmerge_restores_removed_closures`: Tests that undoing UnmergeStations restores merge

### Serialization Tests (undo.rs)
- `test_undo_data_closure_info_serialization`: Full roundtrip serialize/deserialize of ClosureInfo with all fields

### SPEC.md Updates
- Updated Command enum: MergeStations no longer has closure_strategy, added CreateLoopClosure variant
- Updated UndoData: Added UnmergeInfo, ClosureInfo variants; MergeInfo uses removed_closures instead of strategy
- Updated Merge Stations Dialog: simplified (no closure strategy), noted already-connected rejection
- Added Closure Dialog (ClosureDialog.tsx) with closure preview data and strategy selection
- Updated workflow 7.5: Split into Merge vs Loop Closure paths
- Added ClosureDialog.tsx to project structure tree

### E2E Playwright Tests
- `merge-closure-dialogs.spec.ts`: 4 tests covering MergeDialog rendering, ClosureDialog rendering with preview data, merge button flow, strategy radio selection
- Added mock IPC handlers for `create_loop_closure` and `unmerge_stations`

### Verified Pre-existing Items
- `test_undo_data_merge_info` at undo.rs:778 already uses `removed_closures` (no `strategy` field) - confirmed correct
- No `survey-merges` references in SPEC.md - confirmed absent
## Evidence
- Commits:
- Tests:
- PRs: