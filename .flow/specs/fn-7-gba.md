# Bugfix: Back Button Causes App Freeze with Blank Window

## Problem

Clicking the "← Back" button in the toolbar (Single System View) causes the app to freeze and display a blank dark purple window. The window becomes unresponsive (content doesn't respond, though window chrome still works). User must force-quit the app.

**Error from console:**
```
TypeError: undefined is not an object (evaluating 'this.style.getLayer')
```

The error occurs in `GridOverlay` component during cleanup when the component tries to call `map.getLayer()` after the map's internal `style` object has been destroyed.

## Root Cause

When the Back button triggers `closeProject()`:
1. `closeProject()` clears project state: `project: null, stations: []`
2. This triggers React re-renders of child components
3. `MapCanvas` unmount runs `map.current?.remove()` which destroys the map
4. `GridOverlay`'s cleanup effect tries to call `map.getLayer()` 
5. But `map.style` is already undefined/destroyed → **TypeError crash**

The issue is a **race condition** in cleanup effect ordering - `GridOverlay` cleanup runs after the map is already destroyed.

## Affected Files

| File | Issue |
|------|-------|
| `src/components/Map/GridOverlay.tsx:150-158` | Cleanup effect calls `map.getLayer()` and `map.getSource()` without checking if map style exists |
| `src/components/Map/SurveyLayer.tsx` | `destroy()` method calls `map.getLayer()`/`getSource()` without guards |
| `src/components/Map/MapCanvas.tsx:542-545` | Parent component destroys map in cleanup |

## Fix Approach

### 1. Create shared helper for safe map access

```typescript
// src/components/Map/mapUtils.ts
export function hasLiveStyle(map: maplibregl.Map | null): boolean {
  return !!(map && (map as any).style);
}
```

### 2. Guard ALL map cleanup operations with try/catch

Both `map.getLayer()` and `map.getSource()` can throw after `map.remove()` because the internal `style` is destroyed. The guard check alone still has a small race window between check and call.

```typescript
// GridOverlay.tsx cleanup pattern
return () => {
  if (!hasLiveStyle(map)) return;
  
  try {
    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
    }
    if (map.getSource(sourceId)) {
      map.removeSource(sourceId);
    }
  } catch {
    // Map already destroyed, cleanup not needed
  }
  layerAdded.current = false;
};
```

**Important**: The cleanup runs even when `showGrid` is false because it unconditionally calls `map.getLayer()`. The guard must be added regardless of grid visibility state.

### 3. Audit scope - search entire repo

Search for all instances of these patterns in cleanup/unmount code:
- `map.getLayer()`
- `map.getSource()`
- `map.removeLayer()`
- `map.removeSource()`

Files to explicitly audit and fix:
- `src/components/Map/GridOverlay.tsx` - cleanup effect
- `src/components/Map/SurveyLayer.tsx` - `destroy()` method
- Any other components found via repo search

### 4. Add closing guard for rapid Back clicks

Add an in-flight guard to prevent multiple concurrent close operations:

```typescript
// In useProject.ts or projectStore.ts
const [isClosing, setIsClosing] = useState(false);

const handleCloseProject = async () => {
  if (isClosing) return; // Ignore additional clicks
  setIsClosing(true);
  try {
    // ... existing logic
  } finally {
    setIsClosing(false);
  }
};
```

Or disable the Back button while closing is in progress.

## Edge Cases

- Clicking Back with unsaved changes → show dialog, then clean exit
- Clicking Back without unsaved changes → clean exit directly
- Clicking Back immediately after opening project
- Clicking Back during map loading (before `mapLoaded` is true)
- Multiple rapid Back clicks → **guard prevents concurrent closes**
- Grid visible vs hidden when clicking Back → **guard handles both**

## Expected Behavior After Fix

1. **With unsaved changes**: Show "Unsaved Changes" dialog → User clicks "Discard Changes" → Return to Global View smoothly
2. **Without unsaved changes**: Click Back → Return to Global View immediately
3. **No crashes, no blank screens, no freezes**
4. **Rapid clicks handled gracefully** - subsequent clicks ignored while closing

## Quick Commands

```bash
# Type check
pnpm tsc --noEmit

# Run dev server
./scripts/dev.sh

# Run Playwright tests
pnpm test:ui

# Run WebdriverIO E2E tests  
pnpm test:e2e
```

## Test Strategy

### Playwright Test Requirements

Create `src/tests/back-button-navigation.spec.ts`:

1. **Setup**: Use `page.on('pageerror', ...)` to fail test on any JS error
2. **Capture console errors**: `page.on('console', ...)` with message type 'error'
3. **Test flow**:
   - Open a project → Click "← Back" → Assert GlobalView visible
   - Assert no `pageerror` events fired
   - Assert no console errors captured
4. **Test with dirty state**: Make a change, click Back, handle Unsaved Changes dialog

### WebdriverIO Test Requirements

Create `e2e/test/specs/back-button.e2e.ts`:

1. **Click actual Back button** (not just store-level reset)
2. **Handle Unsaved Changes dialog** if it appears
3. **Assert GlobalView displayed** after navigation
4. **Assert React still mounted**: Check `document.getElementById('root').innerHTML.length > 50`
5. **Capture JS errors**: Use `window.onerror` collector exposed via `__E2E_TEST__`

Example error collector pattern:
```typescript
// In test setup
await browser.execute(() => {
  (window as any).__testErrors = [];
  window.onerror = (msg) => (window as any).__testErrors.push(msg);
});

// After test action
const errors = await browser.execute(() => (window as any).__testErrors);
expect(errors).toHaveLength(0);
```

## Acceptance Criteria

- [ ] Back button returns to Global View without crashing
- [ ] No JavaScript errors in console when clicking Back
- [ ] Works with both dirty and clean project state
- [ ] Unsaved changes dialog appears when appropriate
- [ ] `hasLiveStyle()` helper created in `src/components/Map/mapUtils.ts`
- [ ] GridOverlay cleanup uses guard + try/catch
- [ ] SurveyLayer.tsx `destroy()` uses guard + try/catch  
- [ ] Repo-wide search done for getLayer/getSource in cleanup code
- [ ] Rapid Back click guard implemented
- [ ] Playwright test with pageerror/console.error assertions
- [ ] WebdriverIO test clicking actual Back button with error capture
- [ ] All existing tests pass
- [ ] No TypeScript errors (note: `(map as any).style` for internal access)

## References

- GridOverlay cleanup: `src/components/Map/GridOverlay.tsx:150-158`
- SurveyLayer destroy: `src/components/Map/SurveyLayer.tsx`
- MapCanvas cleanup: `src/components/Map/MapCanvas.tsx:542-545`
- closeProject: `src/store/projectStore.ts:193-199`
- handleCloseProject: `src/hooks/useProject.ts:91-106`
- UnsavedChangesDialog: `src/components/Dialogs/UnsavedChangesDialog.tsx`
- E2E test helpers: `src/main.tsx` (exposes `__E2E_TEST__`)
