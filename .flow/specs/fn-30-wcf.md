# Bugfix: Zero datum update creates two undo entries instead of one

## Problem

When updating the GPS coordinates of an existing zero datum station via the EditStationDialog, the undo stack shows **two separate entries**: "Remove zero datum from X:Y" followed by "Set zero datum at X:Y". The user expects a single undoable action.

**Root cause**: In `src/components/Dialogs/EditStationDialog.tsx:98-115`, the `wasZeroDatum && willBeZeroDatum` branch calls `removeZeroDatum()` then `setZeroDatum()` as two separate IPC calls, each pushing its own undo entry.

**Key insight**: The backend's `set_zero_datum()` method (`src-tauri/src/models/project.rs:667-676`) already supports in-place updates — if a zero datum already exists for the station, it updates the GPS coordinates directly. The `removeZeroDatum()` call is unnecessary.

## Key Decisions

- **Frontend-only fix**: Remove the `removeZeroDatum()` call; just call `setZeroDatum()` which updates in place
- **Keep current undo label**: "Set zero datum at X:Y" is accurate enough (no need for "Update" variant)
- **Keep the no-change guard**: Skip the command entirely if lat/lon haven't changed (check lat/lon only, not depth_reference)
- **Testing**: Both a Rust unit test (verify undo data correctness for update case) AND an E2E Playwright test (verify single undo dropdown entry)
- **E2E fixture**: Use an existing test project file, set zero datum via UI as part of setup

## Additional Benefit

The fix eliminates a partial-failure state: previously, if `removeZeroDatum()` succeeded but `setZeroDatum()` failed, the datum was left removed with no way to recover except manual undo. With the single-call fix, `setZeroDatum()` either succeeds or fails atomically — the datum is never inadvertently removed.

## Scope

- **In scope**: Fix the `wasZeroDatum && willBeZeroDatum` branch in EditStationDialog, verify undo data capture path, add Rust test, add E2E test
- **Out of scope**: Changing undo labels, batch command infrastructure, other dialogs

## Verification Required During Planning

Confirm that when `SetZeroDatum` runs on a station that already has a zero datum, the undo data capture correctly stores `previous_gps: Some(old_gps)` and `previous_offsets` (the section offsets before recomputation). Read the undo data capture code in `src-tauri/src/core/state/undo.rs` to verify.

## Edge Cases

- User unchecks "Set as Zero Datum" then re-checks with new coordinates in the same dialog session → `wasZeroDatum=true, willBeZeroDatum=true` → handled correctly by the fix
- GPS coordinates unchanged → no-change guard skips the command entirely (no undo entry)
- Station has no existing zero datum → `!wasZeroDatum && willBeZeroDatum` branch, unaffected by fix

## Acceptance

- [ ] Updating GPS coordinates on an existing zero datum produces exactly ONE undo entry
- [ ] Undo restores the previous GPS coordinates and section offsets correctly
- [ ] No-change guard: saving without modifying lat/lon does not create an undo entry
- [ ] Rust unit test: SetZeroDatum on existing datum captures correct undo data (previous_gps = Some(old), previous_offsets preserved)
- [ ] E2E Playwright test: undo dropdown shows exactly one new entry after GPS update
- [ ] Partial-failure state eliminated (no remove+set sequence)
