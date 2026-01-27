# fn-28-rpu.3 Frontend error handling, docs update, and E2E test

## Description

Update the frontend to handle undo/redo failures: show toast notifications with failure reason and always call `refreshProjectState()` regardless of success/failure. Add a Playwright E2E test for the undo/redo happy path. Update docs/SPEC.md with the new failure behavior.

**Size:** M
**Files:** `src/store/projectStore.ts`, `e2e-playwright/` (new spec file), `docs/SPEC.md`

## Approach

**Frontend error handling:**
- In `projectStore.ts` — update `undoTo` (lines 745-751) and `redoTo` (lines 754-760) actions:
  - Check `CommandResult.success` from IPC invoke result
  - On failure: call `uiStore.showToast(result.error, 'undo-failed')` (or `'redo-failed'`)
  - Always call `refreshProjectState()` regardless of success/failure (currently only called on success)
- Check if bare `undo()`/`redo()` actions (called by keyboard shortcuts at `useKeyboardShortcuts.ts:501-509`) also need the same treatment — they should show toast on failure and always refresh.
- Use existing toast system at `src/store/uiStore.ts:546-568` — `showToast(message, key)` with 5-second throttle per key.

**Playwright E2E test:**
- Add happy-path test: perform an action, undo it (entry moves to redo stack), redo it (entry moves back to undo stack).
- Follow existing patterns in `e2e-playwright/undo-redo-dropdown.spec.ts` — uses `extendMocksWithUndoRedo(page, config)`.
- Use deterministic assertions (not `waitForTimeout`) per project conventions.

**Documentation:**
- Update `docs/SPEC.md` sections 8.3-8.4 with the new failure behavior: entries pushed back on failure, enhanced undo_to/redo_to messages.

## Key context

- Toast throttle uses 5-second cooldown per key — use distinct keys like `'undo-failed'` / `'redo-failed'` so they don't conflict with other toasts.
- `refreshProjectState()` defined at `projectStore.ts:488-504` — updates all project state including canUndo/canRedo.
- `isDirty` should NOT be set on failed undo/redo (no data change occurred).
- Keyboard shortcuts call bare `undo()`/`redo()` — check if these are the same store actions or different code paths.
- Playwright memory pitfall: "wait for `__cavechef_map__` after canvas appears" and "use deterministic assertions, not `waitForTimeout()`".
## Acceptance
- [ ] Frontend shows toast notification with specific failure reason on undo/redo failure
- [ ] Frontend calls `refreshProjectState()` on both success AND failure for undo/redo
- [ ] Toast uses appropriate key for throttling (distinct from other toasts)
- [ ] Keyboard shortcut undo/redo path also handles failures (toast + refresh)
- [ ] Playwright E2E test: undo/redo happy path (entry moves between stacks correctly)
- [ ] docs/SPEC.md updated with failure behavior in sections 8.3-8.4
- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm test:ui` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
