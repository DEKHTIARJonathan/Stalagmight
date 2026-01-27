# fn-30-wcf.1 Fix zero datum update branch and add tests

## Description

Fix the `wasZeroDatum && willBeZeroDatum` branch in `EditStationDialog.tsx` to call only `setZeroDatum()` instead of `removeZeroDatum()` + `setZeroDatum()`. Add a Rust unit test verifying undo data correctness, undo restoration, and no-change guard. Add an E2E Playwright test with extended mocks verifying a single undo entry.

**Size:** M
**Files:** `src/components/Dialogs/EditStationDialog.tsx`, `src-tauri/src/core/state/tests.rs`, `e2e-playwright/*.spec.ts`, `e2e-playwright/mocks/tauri-ipc.ts`

## Approach

### Frontend fix
In `EditStationDialog.tsx:81-116`, remove the `removeZeroDatum(stationRef)` call and its error handling in the `wasZeroDatum && willBeZeroDatum` branch. Keep only the `setZeroDatum()` call with the updated GPS coordinates. The no-change guard (lat/lon comparison) stays as-is.

### Rust unit test
Follow existing pattern at `src-tauri/src/core/state/tests.rs:1641-1750` (`test_undo_set_zero_datum_restores_section_offsets`).
- Test 1 (update + undo data): Set initial zero datum with GPS-A, then call `set_zero_datum` again with GPS-B. Verify `previous_gps` is `Some(GPS-A)` and `previous_offsets` are captured.
- Test 2 (update + undo restoration): After update, perform undo. Assert the datum GPS is restored to GPS-A and section offsets are restored to pre-update values.
- Test 3 (no-change guard): Verify that the no-change guard works correctly — either the backend skips a no-op SetZeroDatum, or confirm the guard is frontend-only and add an E2E test for it. Must be a concrete test, not documentation-only.

### E2E Playwright test
Follow existing patterns in `e2e-playwright/undo-redo-dropdown.spec.ts`.
- Extend mocks in `e2e-playwright/mocks/tauri-ipc.ts` to handle `set_zero_datum` and `remove_zero_datum` IPC commands by updating the mock undo stack.
- Inject initial zero datum state via `__E2E_TEST__` store state or mock project injection so the dialog opens in the `wasZeroDatum && willBeZeroDatum` path.
- After GPS update via dialog, assert the undo stack count delta is exactly 1 (not absolute count, since baseline may vary).
- Verify no-change case: open dialog, save without changing lat/lon, assert no new undo entry.

## Key context

- Backend `set_zero_datum()` already handles in-place updates at `src-tauri/src/models/project.rs:667-676` — no backend changes needed.
- Undo data capture at `src-tauri/src/core/state/undo.rs:186-205` already correctly captures `previous_gps: Some(old_gps)` when a datum exists.
- E2E mock file: `e2e-playwright/mocks/tauri-ipc.ts` — must handle `set_zero_datum` and `remove_zero_datum`.
- E2E helpers: `e2e-playwright/helpers/app.ts`.
- Use deterministic assertions instead of `waitForTimeout()`.
- Use specific `data-testid` selectors: `toolbar-undo-button-dropdown`, `toolbar-undo-button-item-{index}`, `edit-station-dialog`.

## Acceptance
- [ ] `wasZeroDatum && willBeZeroDatum` branch calls only `setZeroDatum()` (no `removeZeroDatum()`)
- [ ] Updating GPS on existing zero datum produces exactly ONE undo entry
- [ ] Rust test: SetZeroDatum on existing datum captures `previous_gps = Some(old)` and `previous_offsets`
- [ ] Rust test: Undo after update restores previous GPS coordinates and section offsets
- [ ] Concrete test (Rust or E2E): No-change guard verified — saving without modifying lat/lon creates no undo entry
- [ ] E2E test: Mocks extended in `e2e-playwright/mocks/tauri-ipc.ts` for `set_zero_datum`/`remove_zero_datum`
- [ ] E2E test: Initial zero datum state injected so update path is exercised
- [ ] E2E test: Undo dropdown count delta is exactly 1 after GPS update
- [ ] E2E test: No-change save creates no new undo entry
- [ ] `pnpm tsc --noEmit` passes
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] `pnpm test:ui` passes

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
