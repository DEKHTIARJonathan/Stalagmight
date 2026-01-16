# fn-3-m4h.1 Add Escape handling to useKeyboardShortcuts

## Description
Add Escape-to-close dialogs in the global keyboard handler. This is a single-file change.

## File to Change

- `src/hooks/useKeyboardShortcuts.ts`

## Change

Move Escape handling to the TOP of `handleKeyDown`, BEFORE the input focus guard:

```typescript
// At the START of handleKeyDown function
const key = e.key.toLowerCase();

// Handle Escape FIRST - works even when focus is in an input
if (key === 'escape' || key === 'esc') {
  // Close any open dialog
  const { activeDialog, closeDialog: closeActiveDialog } = useUIStore.getState();
  if (activeDialog) {
    closeActiveDialog();
    // IMPORTANT: Don't return - continue to clear tool state
  }

  // Always clear tool state (existing behavior)
  clearSelection();
  clearMergeStations();
  clearMeasure();
  setDrawFromStation(null);
  return;
}

// THEN the input focus guard (existing ~line 42-48)
if (target instanceof HTMLElement) {
  const tagName = target.tagName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
    return;
  }
}
```

## Why This Order

1. Escape is handled BEFORE input focus check - so it works when typing in dialogs
2. closeDialog() is called if activeDialog is set
3. Tool state is STILL cleared (no early return) - preserves cleanup for merge/draw/measure
4. Handle both 'escape' and 'esc' for browser compatibility
## Files to Change

- `src/hooks/useKeyboardShortcuts.ts`

## Changes

Modify the Escape key handler (currently at lines 114-121) to check for and close active dialogs first.

```typescript
if (key === 'escape') {
  // First: close any open dialog
  const { activeDialog, closeDialog } = useUIStore.getState();
  if (activeDialog) {
    closeDialog();
    return;
  }

  // Then: clear selection/tool state (existing behavior)
  clearSelection();
  clearMergeStations();
  clearMeasure();
  setDrawFromStation(null);
  return;
}
```

## Why

The test "should allow keyboard shortcut to open import dialog" expects Escape to close dialogs. Currently Escape only clears selection/tool state. This provides a global fallback in case individual dialog handlers don't fire.

## Note

This works independently of individual DialogWrapper Escape handlers (belt and suspenders approach). Both can coexist without conflict since `closeDialog()` is idempotent.
## Acceptance
- [ ] Escape handling moved before input focus guard in useKeyboardShortcuts.ts
- [ ] Checks both 'escape' and 'esc' key names
- [ ] Calls closeDialog() when activeDialog is set
- [ ] Does NOT return early after closing - continues to clear tool state
- [ ] TypeScript compiles without errors (`pnpm tsc --noEmit`)
- [ ] All Playwright tests pass (`pnpm test:ui`)
- [ ] Test "should allow keyboard shortcut to open import dialog" passes
## Done summary
Added Escape key handling to useKeyboardShortcuts.ts that closes any open dialog via closeDialog() before clearing tool state.
## Evidence
- Commits:
- Tests: pnpm tsc --noEmit
- PRs: