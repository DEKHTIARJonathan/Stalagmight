# fn-28-rpu.3 Frontend error handling, docs update, and E2E test

## Description

Update the frontend to handle undo/redo failures: show toast notifications with failure reason and always call `refreshProjectState()` regardless of success/failure. Add a Playwright E2E test for the undo/redo happy path. Update docs/SPEC.md with the new failure behavior.

**Size:** M
**Files:** `src/store/projectStore.ts`, `e2e-playwright/undo-redo-dropdown.spec.ts`, `docs/SPEC.md`

## Approach

**Frontend error handling:**
- In `projectStore.ts` — update `undoTo` (lines 745-751) and `redoTo` (lines 754-760) actions:
  - Check `CommandResult.success` from IPC invoke result
  - On failure: call `useUIStore.getState().showToast(result.error ?? 'Unknown error', 'undo-failed')` (or `'redo-failed'`). **Guard against null/undefined** `result.error`.
  - Use `try/finally` so `refreshProjectState()` runs even if `invoke()` throws (currently only called on success)
- Check if bare `undo()`/`redo()` actions (called by keyboard shortcuts at `useKeyboardShortcuts.ts:501-509`) also need the same treatment — they should show toast on failure and always refresh.
- Use existing toast system at `src/store/uiStore.ts:546-568` — access via `useUIStore.getState().showToast(message, key)` (NOT `uiStore.showToast()`). 5-second throttle per key.
- `isDirty` should NOT be set on failed undo/redo (no data change occurred).

**Playwright E2E test:**
- **Extend the existing mock layer** in `e2e-playwright/undo-redo-dropdown.spec.ts` to handle `undo`/`redo` commands by mutating the mock `undoStack`/`redoStack` arrays and deriving `canUndo`/`canRedo` from array lengths. Do NOT create a new spec file.
- Add happy-path test: perform an action, undo it (entry moves from undo to redo stack), redo it (entry moves back to undo stack).
- Follow existing patterns in `extendMocksWithUndoRedo(page, config)` at `undo-redo-dropdown.spec.ts:78-128`.
- Use deterministic assertions (not `waitForTimeout`) per project conventions.

**Documentation:**
- Update `docs/SPEC.md` section 8.4 "Multi-step undo/redo" with failure behavior: entries pushed back on failure, enhanced undo_to/redo_to messages.
- If `ZeroDatumInfo` fields in section 8.3 are out of sync with code, fix them while editing that area.

## Key context

- Toast throttle uses 5-second cooldown per key — use distinct keys like `'undo-failed'` / `'redo-failed'` so they don't conflict with other toasts.
- `refreshProjectState()` defined at `projectStore.ts:488-504` — updates all project state including canUndo/canRedo.
- Keyboard shortcuts call bare `undo()`/`redo()` — check if these are the same store actions or different code paths.
- Playwright memory pitfall: "wait for `__cavechef_map__` after canvas appears" and "use deterministic assertions, not `waitForTimeout()`".
- Existing mock `extendMocksWithUndoRedo` returns fixed stacks — extend to support mutation via `undo`/`redo` intercepts.

## Acceptance
- [ ] Frontend shows toast notification with specific failure reason on undo/redo failure (null-guarded: `result.error ?? 'Unknown error'`)
- [ ] Frontend calls `refreshProjectState()` on both success AND failure for undo/redo (via try/finally)
- [ ] Toast uses appropriate key for throttling (distinct from other toasts)
- [ ] Keyboard shortcut undo/redo path also handles failures (toast + refresh)
- [ ] Playwright E2E test: undo/redo happy path with extended mocks in existing `undo-redo-dropdown.spec.ts` (entry moves between stacks)
- [ ] docs/SPEC.md updated: failure behavior under section 8.4, fix ZeroDatumInfo if out of sync
- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm test:ui` passes

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
