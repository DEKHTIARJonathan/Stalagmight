# fn-30-wcf.1 Fix zero datum update branch and add tests

## Description

Fix the `wasZeroDatum && willBeZeroDatum` branch in `EditStationDialog.tsx` to call only `setZeroDatum()` instead of `removeZeroDatum()` + `setZeroDatum()`. Add a Rust unit test verifying undo data correctness for the update case, and an E2E Playwright test verifying a single undo dropdown entry.

**Size:** M
**Files:** `src/components/Dialogs/EditStationDialog.tsx`, `src-tauri/src/core/state/tests.rs`, `e2e-playwright/*.spec.ts`

## Approach

- In `EditStationDialog.tsx:81-116`, remove the `removeZeroDatum(stationRef)` call and its error handling in the `wasZeroDatum && willBeZeroDatum` branch. Keep only the `setZeroDatum()` call with the updated GPS coordinates. The no-change guard (lat/lon comparison) stays as-is.
- Follow existing Rust test pattern at `src-tauri/src/core/state/tests.rs:1641-1750` (`test_undo_set_zero_datum_restores_section_offsets`). Add a new test that: (1) sets an initial zero datum, (2) calls `set_zero_datum` again with different GPS, (3) verifies `previous_gps` is `Some(old_gps)` and `previous_offsets` are captured.
- Follow existing E2E test patterns in `e2e-playwright/undo-redo-dropdown.spec.ts`. Add a test that: (1) opens a project with a zero datum, (2) edits GPS via EditStationDialog, (3) verifies undo dropdown has exactly one new entry (use `toolbar-undo-button-item-{index}` test IDs).

## Key context

- Backend `set_zero_datum()` already handles in-place updates at `src-tauri/src/models/project.rs:667-676` — no backend changes needed.
- Undo data capture at `src-tauri/src/core/state/undo.rs:186-205` already correctly captures `previous_gps: Some(old_gps)` when a datum exists — verified by repo-scout.
- E2E memory pitfall: use `waitForFunction(__cavechef_map__)` after canvas appears; use deterministic assertions instead of `waitForTimeout()`.
- Use specific `data-testid` selectors, not generic CSS selectors.
## Acceptance
- [ ] `wasZeroDatum && willBeZeroDatum` branch calls only `setZeroDatum()` (no `removeZeroDatum()`)
- [ ] Updating GPS on existing zero datum produces exactly ONE undo entry
- [ ] Undo restores previous GPS coordinates and section offsets correctly
- [ ] No-change guard: saving without modifying lat/lon creates no undo entry
- [ ] Rust unit test passes: SetZeroDatum on existing datum captures `previous_gps = Some(old)` and `previous_offsets`
- [ ] E2E Playwright test passes: undo dropdown shows exactly one new entry after GPS coordinate update
- [ ] `pnpm tsc --noEmit` passes
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] `pnpm test:ui` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
