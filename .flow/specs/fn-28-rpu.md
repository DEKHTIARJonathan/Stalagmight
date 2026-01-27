# Fix undo/redo entry loss when operation fails

## Overview

When undo/redo operations fail, the entry is permanently lost from both stacks. The `undo()` function pops the entry before attempting the operation, then only pushes to redo on success. If the operation fails (lock failure, missing entity, JSON parse error), the entry vanishes. Same anti-pattern in `redo()`, `undo_to()`, `redo_to()`.

## Scope

**Backend (Rust):**
- Fix `undo()`, `redo()` to push entry back to original stack on failure
- Fix `undo_to()`, `redo_to()` to stop on failure, push back, return enhanced message with step count
- Add `tracing::error!` on every failure where an entry was popped (log safe summary, not full snapshots)
- New unit tests for failure scenarios

**Frontend (TypeScript):**
- Show toast notification with failure reason on undo/redo failure
- Always call `refreshProjectState()` on both success AND failure (use try/finally)
- Playwright E2E test for undo/redo happy path (extend existing mocks)

**Out of scope:** CommandResult struct changes, dropdown visual changes, `clear()` operation, retry logic.

## Approach

### Backend entry preservation

Restructure `undo()` and `redo()` so that **all post-pop failure paths flow through a single epilogue** — no early `return` statements after the entry has been popped. Use a guard pattern or single-exit structure so that every code path after `pop_undo()`/`pop_redo()` either pushes to the opposite stack (success) or pushes back to the original stack (failure).

**Critical**: The current `undo()` has multiple `return CommandResult::failure(...)` inside match arms after the pop (e.g., project lock, no project). All of these early returns must be eliminated or routed through the push-back epilogue. Same for `redo()`.

- Lock strategy is implementer's choice (hold for entire op OR two-lock with push-back), but entries must never be lost.
- Frontend checks `CommandResult.success`, shows toast via existing `useUIStore.getState().showToast()` system.
- `undo_to`/`redo_to` enhanced message format: `"Undo failed at step {current} of {total}: {reason}"`

### Logging

- Log `tracing::error!` when a popped entry's operation fails. Use safe summary fields: `command = %entry.command.description()`, undo data variant name, and failure reason. **Do NOT log full snapshot JSON** — it can be huge and may leak project data.
- For pre-pop failures (lock failure, empty stack), these are already handled and don't need entry-level logging since no entry exists.

### Frontend error handling

- Use `useUIStore.getState().showToast(result.error ?? 'Unknown error', 'undo-failed')` — guard against null/undefined error.
- Use `try/finally` so `refreshProjectState()` runs even if `invoke()` throws.
- Extend existing Playwright mock layer to handle `undo`/`redo` commands by mutating mock stacks and deriving `canUndo`/`canRedo` from lengths. Add happy-path tests to existing `e2e-playwright/undo-redo-dropdown.spec.ts`.

## Risks & Dependencies

- **fn-25-itw** (dropdown stays open): Touches same frontend files — coordinate timing
- **fn-30-wcf** (zero datum double undo): Touches `undo.rs` — low conflict, different code paths
- **fn-40-tub** (merge/closure separation): Adds new command type to `undo.rs` — no conflict with failure handling
- **Mutex poisoning**: If lock re-acquisition fails when pushing back, log error — entry loss becomes a logged error rather than silent

## Test Notes

- Rust unit tests: verify entry preservation on undo/redo failure, undo_to partial completion with enhanced message
- Playwright E2E: extend existing mocks in `undo-redo-dropdown.spec.ts` to support stack mutation, add happy-path test
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

- [ ] `undo()` pushes entry back to top of undo stack on failure (no early returns after pop)
- [ ] `redo()` pushes entry back to top of redo stack on failure (no early returns after pop)
- [ ] `undo_to()` stops on failure, returns message with step count
- [ ] `redo_to()` stops on failure, returns message with step count
- [ ] `tracing::error!` logged when a popped entry's operation fails (safe summary: command description, undo data variant, reason — no full snapshots)
- [ ] Frontend shows toast notification with specific failure reason (null-guarded)
- [ ] Frontend calls `refreshProjectState()` on both success AND failure (via try/finally)
- [ ] Rust unit tests verify entry preservation on undo/redo failure
- [ ] Rust unit tests verify undo_to/redo_to partial completion and enhanced message
- [ ] Playwright E2E test for undo/redo happy path (extended mocks in existing spec)
- [ ] All existing undo/redo tests continue to pass
- [ ] docs/SPEC.md updated: failure behavior under section 8.4 "Multi-step undo/redo", fix ZeroDatumInfo if out of sync
