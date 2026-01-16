# Fix: "should allow keyboard shortcut to open import dialog" Test

## Problem

The WebdriverIO test expects Escape to close dialogs, but it doesn't work.

## Root Cause

The Escape handler in `useKeyboardShortcuts.ts` only clears selection/tool state - it does NOT call `closeDialog()`.

## Prerequisite: Confirm activeDialog is Single Source of Truth

Before implementing, verify that ALL dialogs in the app go through `openDialog()`/`closeDialog()`:

```bash
# Check all dialogs are driven by activeDialog
rg "activeDialog" src/components/Dialogs/
rg "openDialog\(" src/
```

**Expected**: All dialogs conditionally render based on `activeDialog` (checked in App.tsx). No dialogs should bypass this pattern.

**Note**: Per code review (App.tsx:61-74), all dialogs ARE driven by `activeDialog`. This is confirmed.

## Solution: Single File Change

**`src/hooks/useKeyboardShortcuts.ts`**

Handle Escape intelligently based on whether a dialog is open:

```typescript
const handleKeyDown = (event: KeyboardEvent) => {
  const target = event.target;
  const key = event.key.toLowerCase();

  // Check if a dialog is open (all dialogs use activeDialog)
  const { activeDialog, closeDialog: closeActiveDialog } = useUIStore.getState();

  // Handle Escape - special case
  if (key === 'escape' || key === 'esc') {
    // If dialog is open, close it regardless of input focus
    if (activeDialog) {
      event.preventDefault();
      closeActiveDialog();
      // Clear tool state
      clearSelection();
      clearMergeStations();
      clearMeasure();
      setDrawFromStation(null);
      return;
    }
    
    // No dialog open - preserve existing input focus behavior
    if (target instanceof HTMLElement) {
      const tagName = target.tagName.toLowerCase();
      if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
        return; // Let input handle Escape normally
      }
    }
    
    // Not in input, no dialog - clear tool state (existing behavior)
    clearSelection();
    clearMergeStations();
    clearMeasure();
    setDrawFromStation(null);
    return;
  }

  // For all other keys, check input focus FIRST (existing guard)
  // ... rest of key handling unchanged
};
```

## Behavior Matrix

| Escape Pressed | Dialog Open? | Focus in Input? | Behavior |
|---------------|--------------|-----------------|----------|
| Escape | Yes | Any | Close dialog, clear tools |
| Escape | No | Yes | Normal input Escape |
| Escape | No | No | Clear selection/tools |

## Files to Change

| File | Change |
|------|--------|
| `src/hooks/useKeyboardShortcuts.ts` | Update Escape handling |

## Acceptance Criteria

- [ ] All dialogs confirmed to use activeDialog (prerequisite check)
- [ ] Escape closes dialogs when activeDialog is set
- [ ] Escape in input WITHOUT dialog = normal behavior (preserved)
- [ ] Escape outside input WITHOUT dialog = clear tools (preserved)
- [ ] Uses `event.preventDefault()` when closing dialog
- [ ] TypeScript compiles without errors
- [ ] All tests pass

## Quick Commands

```bash
pnpm tsc --noEmit
pnpm test:ui
export CARGO_TARGET_DIR=/root/CaveChef/src-tauri/target
export SKIP_BUILD=1
xvfb-run --auto-servernum pnpm wdio
```
