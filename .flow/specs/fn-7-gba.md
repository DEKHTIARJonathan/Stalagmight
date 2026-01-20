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
import type maplibregl from 'maplibre-gl';

/**
 * Check if map instance has a live style (not destroyed).
 * Uses internal property access since maplibre-gl doesn't expose this publicly.
 */
export function hasLiveStyle(map: maplibregl.Map | null): boolean {
  return !!(map && (map as any).style);
}
```

### 2. Guard ALL map teardown operations with try/catch

Both `map.getLayer()` and `map.getSource()` can throw after `map.remove()` because the internal `style` is destroyed. The guard check alone still has a small race window between check and call.

Apply `hasLiveStyle()` + try/catch to:
- **React cleanup effects** (e.g., GridOverlay useEffect return)
- **Manual teardown methods** (e.g., `SurveyLayer.destroy()`) - this is critical, not just React cleanups
- **Any other map operations** that could run during unmount or after map destruction

```typescript
// GridOverlay.tsx cleanup pattern
return () => {
  if (!hasLiveStyle(map)) {
    layerAdded.current = false;
    return;
  }
  
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

```typescript
// SurveyLayer.tsx destroy() method - MUST be guarded (manual teardown, not React cleanup)
public destroy(): void {
  if (!hasLiveStyle(this.map)) return;
  
  try {
    // Remove event listeners
    // Remove layers and sources
  } catch {
    // Map already destroyed
  }
}
```

**Important**: The cleanup runs even when `showGrid` is false because it unconditionally calls `map.getLayer()`. The guard must be added regardless of grid visibility state.

### 3. Audit scope - search entire repo

Search for all instances of these patterns in cleanup/unmount/teardown code:
- `map.getLayer()`
- `map.getSource()`
- `map.removeLayer()`
- `map.removeSource()`

Files to explicitly audit and fix:
- `src/components/Map/GridOverlay.tsx` - cleanup effect
- `src/components/Map/SurveyLayer.tsx` - `destroy()` method (manual teardown entry point)
- Any other components found via repo search

### 4. Add closing guard for rapid Back clicks

**Use a ref-based or store-level guard** (NOT useState) to avoid "state update on unmounted component" warnings. The `handleCloseProject` triggers `setView('global')` which unmounts `SingleSystemView`, so a component-level useState would be problematic.

Option A - Ref-based guard in useProject.ts:
```typescript
const isClosingRef = useRef(false);

const handleCloseProject = useCallback(async () => {
  if (isClosingRef.current) return;
  
  if (isDirty) {
    openUnsavedChangesDialog();
    return;
  }
  
  isClosingRef.current = true;
  try {
    await closeProject();
    setView('global');
  } finally {
    isClosingRef.current = false;
  }
}, [isDirty, openUnsavedChangesDialog, closeProject, setView]);
```

Option B - Store-level guard in projectStore.ts:
```typescript
// Add to store state
isClosing: false,

// Guard in closeProject action
```

Also ensure the UnsavedChangesDialog respects this guard.

## Edge Cases

- Clicking Back with unsaved changes → show dialog, then clean exit
- Clicking Back without unsaved changes → clean exit directly
- Clicking Back immediately after opening project
- Clicking Back during map loading (before `mapLoaded` is true)
- Multiple rapid Back clicks → **ref/store guard prevents concurrent closes**
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

Create `e2e-playwright/back-button-navigation.spec.ts` (NOT src/tests - Playwright runs from e2e-playwright/):

1. **Setup**: Use `page.on('pageerror', ...)` to fail test on any JS error
2. **Capture console errors**: `page.on('console', ...)` with message type 'error'
3. **Test flow**:
   - Open a project → Click "← Back" → Assert GlobalView visible
   - Assert no `pageerror` events fired
   - Assert no console errors captured
4. **Test with dirty state**: 
   - **Concrete dirtying action**: Use Zustand's setState directly via `__E2E_TEST__`:
     ```typescript
     await page.evaluate(() => {
       const e2e = (window as any).__E2E_TEST__;
       if (e2e && e2e.projectStore) {
         e2e.projectStore.setState({ isDirty: true });
       }
     });
     ```
   - There is no `setDirty` action - use `setState({ isDirty: true })` directly
   - Click Back, handle Unsaved Changes dialog

### WebdriverIO Test Requirements

Create `e2e/specs/back-button.spec.ts` (NOT e2e/test/specs - WDIO uses e2e/specs/):

1. **Click actual Back button** (not just store-level reset)
2. **Handle Unsaved Changes dialog** if it appears
3. **Assert GlobalView displayed** after navigation
4. **Assert React still mounted**: Check `document.getElementById('root').innerHTML.length > 50`
5. **Capture JS errors**: Set up both `window.onerror` AND `window.onunhandledrejection` collectors:
   ```typescript
   await browser.execute(() => {
     (window as any).__testErrors = [];
     window.onerror = (msg) => (window as any).__testErrors.push(String(msg));
     window.onunhandledrejection = (e) => (window as any).__testErrors.push(e.reason?.message || String(e.reason));
   });
   ```
6. **Concrete dirtying action**: Use `__E2E_TEST__.projectStore.setState({ isDirty: true })`

## Acceptance Criteria

- [ ] Back button returns to Global View without crashing
- [ ] No JavaScript errors in console when clicking Back
- [ ] Works with both dirty and clean project state
- [ ] Unsaved changes dialog appears when appropriate
- [ ] `hasLiveStyle()` helper created in `src/components/Map/mapUtils.ts`
- [ ] GridOverlay cleanup uses guard + try/catch
- [ ] SurveyLayer.tsx `destroy()` uses guard + try/catch (manual teardown path)
- [ ] Repo-wide search done for getLayer/getSource in cleanup/teardown code
- [ ] Rapid Back click guard implemented (ref-based or store-level, NOT useState)
- [ ] Playwright test in `e2e-playwright/back-button-navigation.spec.ts`
- [ ] Playwright test has pageerror/console.error assertions
- [ ] WebdriverIO test in `e2e/specs/back-button.spec.ts`
- [ ] WebdriverIO test captures both onerror AND onunhandledrejection
- [ ] Tests use `__E2E_TEST__.projectStore.setState({ isDirty: true })` for dirtying
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
- Playwright config: `playwright.config.ts` (testDir: './e2e-playwright')
- WDIO specs: `e2e/specs/`
