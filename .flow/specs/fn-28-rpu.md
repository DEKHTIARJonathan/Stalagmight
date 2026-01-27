# Fix undo/redo entry loss when operation fails

## Overview

When undo/redo operations fail, the entry is permanently lost from both stacks. The `undo()` function pops the entry before attempting the operation, then only pushes to redo on success. If the operation fails (lock failure, missing entity, JSON parse error), the entry vanishes. Same anti-pattern in `redo()`, `undo_to()`, `redo_to()`.

## Scope

**Backend (Rust):**
- Fix `undo()`, `redo()` to push entry back to original stack on failure
- Fix `undo_to()`, `redo_to()` to stop on failure, push back, return enhanced message with step count
- Add `tracing::error!` on every failure with entry details
- New unit tests for failure scenarios

**Frontend (TypeScript):**
- Show toast notification with failure reason on undo/redo failure
- Always call `refreshProjectState()` on both success AND failure
- Playwright E2E test for undo/redo happy path

**Out of scope:** CommandResult struct changes, dropdown visual changes, `clear()` operation, retry logic.

## Approach

- Pop entry, attempt operation, push to opposite stack on success OR push back to original stack on failure
- Lock strategy is implementer's choice (hold for entire op OR two-lock with push-back)
- Frontend checks `CommandResult.success`, shows toast via existing `uiStore.showToast()` system
- `undo_to`/`redo_to` enhanced message format: `"Undo failed at step N of M: reason"`

## Risks & Dependencies

- **fn-25-itw** (dropdown stays open): Touches same frontend files — coordinate timing
- **fn-30-wcf** (zero datum double undo): Touches `undo.rs` — low conflict, different code paths
- **fn-40-tub** (merge/closure separation): Adds new command type to `undo.rs` — no conflict with failure handling
- **Mutex poisoning**: If lock re-acquisition fails when pushing back, log error — entry loss becomes a logged error rather than silent

## Test Notes

- Rust unit tests: verify entry preservation on undo/redo failure, undo_to partial completion with enhanced message
- Playwright E2E: undo/redo happy path (entry moves between stacks correctly)
- All existing undo/redo tests must continue to pass

## Quick commands

```bash
# Rust tests
cargo test --manifest-path src-tauri/Cargo.toml -- undo
# TypeScript type check
pnpm tsc --noEmit
# Playwright tests
pnpm test:ui
```

## References

- `src-tauri/src/core/state/undo.rs:330-520` — undo() implementation
- `src-tauri/src/core/state/undo.rs:522-565` — redo() implementation
- `src-tauri/src/core/state/undo.rs:744-777` — undo_to() implementation
- `src-tauri/src/core/state/undo.rs:779-813` — redo_to() implementation
- `src-tauri/src/core/undo.rs:165-182` — push/pop stack helpers
- `src-tauri/src/core/command.rs:111-123` — CommandResult struct
- `src/store/projectStore.ts:745-760` — undoTo/redoTo actions
- `src/store/uiStore.ts:546-568` — toast system
- `src/hooks/useKeyboardShortcuts.ts:501-509` — keyboard undo/redo
- `src-tauri/src/core/state/tests.rs` — existing Rust unit tests
- `e2e-playwright/undo-redo-dropdown.spec.ts` — existing Playwright tests

## Acceptance

- [ ] `undo()` pushes entry back to top of undo stack on failure
- [ ] `redo()` pushes entry back to top of redo stack on failure
- [ ] `undo_to()` stops on failure, returns message with step count
- [ ] `redo_to()` stops on failure, returns message with step count
- [ ] `tracing::error!` logged on every undo/redo failure with reason and entry details
- [ ] Frontend shows toast notification with specific failure reason
- [ ] Frontend calls `refreshProjectState()` on both success AND failure
- [ ] Rust unit tests verify entry preservation on undo/redo failure
- [ ] Rust unit tests verify undo_to/redo_to partial completion and enhanced message
- [ ] Playwright E2E test for undo/redo happy path
- [ ] All existing undo/redo tests continue to pass
- [ ] docs/SPEC.md updated with failure behavior (section 8.3-8.4)
