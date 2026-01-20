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
| `src/components/Map/GridOverlay.tsx:150-158` | Cleanup effect calls `map.getLayer()` without checking if map style exists |
| `src/components/Map/SurveyLayer.ts` | May have similar cleanup issues (needs audit) |
| `src/components/Map/MapCanvas.tsx:542-545` | Parent component destroys map in cleanup |

## Fix Approach

1. **Add guard checks** in cleanup effects before any map operations:
   ```typescript
   // Check if map and style still exist before cleanup
   if (map && map.style && map.getLayer(layerId)) {
     map.removeLayer(layerId);
   }
   ```

2. **Audit all map overlay components** for similar cleanup issues:
   - GridOverlay.tsx
   - SurveyLayer.ts
   - Any other components using the map instance

## Edge Cases

- Clicking Back with unsaved changes → show dialog, then clean exit
- Clicking Back without unsaved changes → clean exit directly
- Clicking Back immediately after opening project
- Clicking Back during map loading (before `mapLoaded` is true)
- Multiple rapid Back clicks

## Expected Behavior After Fix

1. **With unsaved changes**: Show "Unsaved Changes" dialog → User clicks "Discard Changes" → Return to Global View smoothly
2. **Without unsaved changes**: Click Back → Return to Global View immediately
3. **No crashes, no blank screens, no freezes**

## Quick Commands

```bash
# Type check
pnpm tsc --noEmit

# Run dev server
./scripts/dev.sh

# Run Playwright tests
pnpm test:ui

# Run WebdriverIO E2E tests
(cd e2e && pnpm test)
```

## Acceptance Criteria

- [ ] Back button returns to Global View without crashing
- [ ] No JavaScript errors in console when clicking Back
- [ ] Works with both dirty and clean project state
- [ ] Unsaved changes dialog appears when appropriate
- [ ] All map overlay components audited for cleanup issues
- [ ] Playwright E2E test added for Back button navigation
- [ ] WebdriverIO E2E test added for Back button navigation
- [ ] All existing tests pass
- [ ] No TypeScript errors

## References

- GridOverlay cleanup: `src/components/Map/GridOverlay.tsx:150-158`
- MapCanvas cleanup: `src/components/Map/MapCanvas.tsx:542-545`
- closeProject: `src/store/projectStore.ts:193-199`
- handleCloseProject: `src/hooks/useProject.ts:91-106`
- UnsavedChangesDialog: `src/components/Dialogs/UnsavedChangesDialog.tsx`
