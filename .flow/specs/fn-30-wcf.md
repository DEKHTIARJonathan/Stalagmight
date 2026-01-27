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
- UI test IDs: `toolbar-undo-button-dropdown`, `toolbar-undo-button-item-{index}`, `edit-station-dialog`
- UndoData type: `src-tauri/src/core/undo.rs:74-84` — `ZeroDatumInfo { station_ref, previous_gps: Option<GpsCoordinates>, previous_offsets }`
- No documentation updates needed
- No hard epic dependencies; fn-25-itw benefits from this landing first

## Scope

- **In scope**: Fix the frontend branch, add Rust unit test for update case, add E2E Playwright test
- **Out of scope**: Changing undo labels, preview data format, batch command infrastructure, other dialogs

## Acceptance

- [ ] Updating GPS on existing zero datum produces exactly ONE undo entry
- [ ] Undo restores previous GPS coordinates and section offsets correctly
- [ ] No-change guard: saving without modifying lat/lon creates no undo entry
- [ ] Rust unit test: SetZeroDatum on existing datum captures correct undo data (previous_gps = Some(old))
- [ ] E2E Playwright test: undo dropdown shows exactly one new entry after GPS update
- [ ] Partial-failure state eliminated (no remove+set sequence)
