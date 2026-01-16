# Fix: "should allow keyboard shortcut to open import dialog" Test

## Problem

The WebdriverIO test `import-dialog.spec.ts:77` fails with:
```
waitUntil condition timed out after 5000ms
```

The test expects Escape to close the dialog, but it doesn't.

## Root Cause

The app's Escape key handler (useKeyboardShortcuts.ts:114-121) only clears selection and tool state - it does NOT call `closeDialog()`.

## Solution

### Simplified Approach (No Dirty Checking)

The dialog system only supports ONE active dialog at a time. Opening a confirmation dialog would unmount the original dialog, losing its state. Therefore:

1. **Implement Escape-to-close WITHOUT dirty checking** (for now)
2. **Dirty checking deferred** to future enhancement when dialog system supports stacking

### Implementation Strategy

1. **Global Escape Handler** (useKeyboardShortcuts.ts):
   - Check if `activeDialog` is set first
   - If yes, close dialog and return (skip tool state clear)
   - If no, clear selection/tool state as before

2. **Per-dialog Escape handler** (belt and suspenders):
   - Add Escape listener to each dialog's local DialogWrapper
   - Use `stopPropagation()` to prevent double-handling
   - Handles case where global handler is blocked by input focus

### Key Decisions

| Decision | Choice |
|----------|--------|
| Architecture | Global handler + per-dialog handler (belt and suspenders) |
| Dirty confirmation | **Deferred** - dialog system only supports 1 active dialog |
| Event handling | Per-dialog uses `stopPropagation()`, global checks `activeDialog` |
| Input focus | Per-dialog handler works even when focus is in input |

## Files to Change

| File | Change |
|------|--------|
| `src/hooks/useKeyboardShortcuts.ts` | Add dialog close on Escape before tool state clear |
| `src/components/Dialogs/ImportDialog.tsx` | Add Escape handler to DialogWrapper |
| `src/components/Dialogs/DmpImportDialog.tsx` | Add Escape handler (if has local wrapper) |
| `src/components/Dialogs/NewProjectDialog.tsx` | Add Escape handler |
| `src/components/Dialogs/ExportDialog.tsx` | Add Escape handler |
| Other dialogs with local wrappers | Add Escape handler |

## Implementation Details

### Global Escape Handler (useKeyboardShortcuts.ts)

```typescript
// In handleKeyDown callback, REPLACE existing Escape handling:

if (key === 'escape') {
  // First: close any open dialog
  const { activeDialog, closeDialog: closeActiveDialog } = useUIStore.getState();
  if (activeDialog) {
    closeActiveDialog();
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

Note: This works even when focus is in inputs because we call `useUIStore.getState()` directly rather than relying on the hook's destructured values.

### Per-Dialog Escape Handler (add to each DialogWrapper)

```tsx
// Add to each dialog's local DialogWrapper component
function DialogWrapper({ title, onClose, children, ...props }: DialogWrapperProps) {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        if (e.repeat) return;  // Ignore held keys
        e.stopPropagation();   // Prevent global handler double-close
        onClose();
      }
    };

    // Capture phase to handle before inputs consume the event
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* ... existing code ... */}
    </div>
  );
}
```

### Dialogs Requiring Updates

Check each dialog for existing local DialogWrapper:

| Dialog | Has Local Wrapper | Needs Escape Handler |
|--------|-------------------|---------------------|
| ImportDialog.tsx | Yes | Yes |
| DmpImportDialog.tsx | Check | If yes |
| NewProjectDialog.tsx | Check | If yes |
| ExportDialog.tsx | Check | If yes |
| ConfirmDialog.tsx | Check | If yes |
| ErrorDialog.tsx | Check | If yes |
| EditShotDialog.tsx | Check | If yes |
| EditStationDialog.tsx | Check | If yes |
| EditSectionDialog.tsx | Check | If yes |
| DrawShotDialog.tsx | Check | If yes |
| MergeDialog.tsx | Check | If yes |
| OverwriteConfirmDialog.tsx | Check | If yes |
| UnsavedChangesDialog.tsx | Check | If yes |

## Why Not Dirty Checking Now

The current dialog system has these constraints:

1. **Single activeDialog**: Only one dialog can be open at a time
2. **State loss on switch**: Opening a new dialog unmounts the previous one
3. **UnsavedChangesDialog is specialized**: It's for project close, not generic confirmation
4. **ConfirmDialog is specialized**: It's for delete operations, not generic confirmation

To implement proper dirty checking would require:
- Dialog stacking support (complex)
- Generic confirmation dialog (new component)
- State preservation across dialog switches

This is a larger refactor that should be a separate epic.

## Acceptance Criteria

- [ ] Escape key closes dialogs when `activeDialog` is set
- [ ] Global handler in `useKeyboardShortcuts.ts` checks `activeDialog` first
- [ ] Per-dialog handlers added to dialogs with local DialogWrapper
- [ ] Per-dialog handlers use `stopPropagation()` to prevent double-close
- [ ] Per-dialog handlers check `e.repeat` to ignore held keys
- [ ] Per-dialog handlers accept both `'Escape'` and `'Esc'` keys
- [ ] Test "should allow keyboard shortcut to open import dialog" passes
- [ ] All WebdriverIO tests pass
- [ ] Playwright tests unaffected
- [ ] Rust backend tests unaffected

## Future Enhancement (Deferred)

Create separate epic for:
- [ ] Dialog stacking support
- [ ] Generic confirmation dialog component
- [ ] Dirty state tracking per dialog
- [ ] Confirmation before closing dirty dialogs

## Quick Commands

```bash
# Run the specific failing test
export CARGO_TARGET_DIR=/root/CaveChef/src-tauri/target
export SKIP_BUILD=1
xvfb-run --auto-servernum pnpm wdio run wdio.conf.ts --spec ./e2e/specs/import-dialog.spec.ts

# Run all WebdriverIO tests
xvfb-run --auto-servernum pnpm test:e2e

# TypeScript check
pnpm tsc --noEmit
```

## Implementation Checklist

- [ ] Update `src/hooks/useKeyboardShortcuts.ts` with global Escape handler
- [ ] Add Escape handler to `ImportDialog.tsx` DialogWrapper
- [ ] Add Escape handler to `DmpImportDialog.tsx` (if has wrapper)
- [ ] Add Escape handler to `NewProjectDialog.tsx` (if has wrapper)
- [ ] Add Escape handler to `ExportDialog.tsx` (if has wrapper)
- [ ] Add Escape handler to `ConfirmDialog.tsx` (if has wrapper)
- [ ] Add Escape handler to `ErrorDialog.tsx` (if has wrapper)
- [ ] Add Escape handler to `EditShotDialog.tsx` (if has wrapper)
- [ ] Add Escape handler to `EditStationDialog.tsx` (if has wrapper)
- [ ] Add Escape handler to `EditSectionDialog.tsx` (if has wrapper)
- [ ] Add Escape handler to `DrawShotDialog.tsx` (if has wrapper)
- [ ] Add Escape handler to `MergeDialog.tsx` (if has wrapper)
- [ ] Add Escape handler to `OverwriteConfirmDialog.tsx` (if has wrapper)
- [ ] Add Escape handler to `UnsavedChangesDialog.tsx` (if has wrapper)
- [ ] Run TypeScript check
- [ ] Run all tests
