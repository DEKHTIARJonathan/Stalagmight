# Bugfix: Zero datum update creates two undo entries instead of one

## Problem

When updating GPS coordinates of an existing zero datum station via EditStationDialog, the undo stack shows **two separate entries** instead of one. The `wasZeroDatum && willBeZeroDatum` branch at `src/components/Dialogs/EditStationDialog.tsx:81-116` calls `removeZeroDatum()` then `setZeroDatum()` as two separate IPC calls, each pushing its own undo entry.

The backend's `set_zero_datum()` at `src-tauri/src/models/project.rs:667-676` already supports in-place updates — the `removeZeroDatum()` call is unnecessary.

## Fix

Remove the `removeZeroDatum()` call in the `wasZeroDatum && willBeZeroDatum` branch. Call only `setZeroDatum()`, which updates in place. This also eliminates a partial-failure state where remove succeeds but set fails.

## Quick commands

```bash
# Type check
pnpm tsc --noEmit
# Rust tests
cargo test --manifest-path src-tauri/Cargo.toml
# E2E tests
pnpm test:ui
```

## Key context

- Backend in-place update: `src-tauri/src/models/project.rs:667-676`
- Undo data capture (correct as-is): `src-tauri/src/core/state/undo.rs:186-205`
- IPC commands: `src-tauri/src/commands/station.rs:40-69`
- Existing Rust undo test: `src-tauri/src/core/state/tests.rs:1641-1750`
- Existing E2E tests: `e2e-playwright/undo-redo-dropdown.spec.ts`, `e2e-playwright/id-zero-regression.spec.ts`
- E2E mock file: `e2e-playwright/mocks/tauri-ipc.ts` — must be extended to handle `set_zero_datum` and `remove_zero_datum` IPC commands
- E2E helpers: `e2e-playwright/helpers/app.ts`
- UI test IDs: `toolbar-undo-button-dropdown`, `toolbar-undo-button-item-{index}`, `edit-station-dialog`
- UndoData type: `src-tauri/src/core/undo.rs:74-84` — `ZeroDatumInfo { station_ref, previous_gps: Option<GpsCoordinates>, previous_offsets }`
- E2E state injection: Use `__E2E_TEST__` store state or mock project injection to set initial zero datum so the update path (`wasZeroDatum && willBeZeroDatum`) is exercised
- No documentation updates needed
- No hard epic dependencies; fn-25-itw benefits from this landing first

## Scope

- **In scope**: Fix the frontend branch, add Rust unit test for update case (including undo restoration and no-change guard), add E2E Playwright test (with mock extension)
- **Out of scope**: Changing undo labels, preview data format, batch command infrastructure, other dialogs

## Acceptance

- [ ] Updating GPS on existing zero datum produces exactly ONE undo entry
- [ ] Undo restores previous GPS coordinates and section offsets correctly (verified by Rust test: update → undo → assert restored GPS and offsets)
- [ ] No-change guard: saving without modifying lat/lon creates no undo entry (verified by concrete test — Rust or E2E, not documentation-only)
- [ ] Rust unit test: SetZeroDatum on existing datum captures correct undo data (previous_gps = Some(old)), then undo restores previous state
- [ ] E2E Playwright test: extends mocks in `e2e-playwright/mocks/tauri-ipc.ts` for set_zero_datum/remove_zero_datum, injects initial zero datum state, verifies undo dropdown count delta is exactly 1 after GPS update
- [ ] Partial-failure state eliminated (no remove+set sequence)
