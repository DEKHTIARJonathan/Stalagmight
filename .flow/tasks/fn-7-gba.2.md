# fn-7-gba.2 Audit and fix all map overlay components for cleanup issues

## Description
Audit and fix all map overlay components for cleanup issues, including rapid Back click protection.

## Implementation

### 1. Fix SurveyLayer.tsx `destroy()` method

Import the helper:
```typescript
import { hasLiveStyle } from './mapUtils';
```

Update destroy method - apply `hasLiveStyle()` to this manual teardown method (not just React cleanups):
```typescript
public destroy(): void {
  // Guard against map being destroyed
  if (!hasLiveStyle(this.map)) return;
  
  try {
    // Remove event listeners first
    this.map.off('mouseenter', this.stationsLayerId, this.onStationMouseEnter);
    // ... other event listener removals
    
    // Remove layers and sources
    if (this.map.getLayer(this.stationsLayerId)) {
      this.map.removeLayer(this.stationsLayerId);
    }
    if (this.map.getLayer(this.shotsLayerId)) {
      this.map.removeLayer(this.shotsLayerId);
    }
    if (this.map.getSource(this.sourceId)) {
      this.map.removeSource(this.sourceId);
    }
  } catch {
    // Map already destroyed, cleanup not needed
  }
}
```

### 2. Repo-wide search for cleanup patterns

Run these searches to find any other cleanup code that needs guards:

```bash
# Find all map.getLayer calls
rg "map\.getLayer\(" src/components/Map/ --type ts --type tsx

# Find all map.getSource calls  
rg "map\.getSource\(" src/components/Map/ --type ts --type tsx

# Find all removeLayer/removeSource calls
rg "(removeLayer|removeSource)" src/components/Map/ --type ts --type tsx

# Look for cleanup effects with map operations
rg "return \(\) =>" src/components/Map/ -A 10
```

### 3. Add rapid Back click guard (ref-based or store-level)

**IMPORTANT**: Do NOT use `useState` - the component unmounts during close which causes "state update on unmounted component" warnings.

Option A - Ref-based guard in `src/hooks/useProject.ts`:

```typescript
const isClosingRef = useRef(false);

const handleCloseProject = useCallback(async () => {
  // Prevent concurrent close operations using ref (survives unmount)
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

Option B - Store-level guard in `src/store/projectStore.ts`:
```typescript
// Add to store state
isClosing: false,

// Guard in closeProject action
```

Also ensure the UnsavedChangesDialog respects this guard.

### 4. Files to check

- `src/components/Map/SurveyLayer.tsx` - `destroy()` method (manual teardown, not just React cleanup)
- `src/components/Map/GridOverlay.tsx` - already fixed in task 1
- `src/components/Map/MapCanvas.tsx` - verify cleanup order
- `src/hooks/useProject.ts` - add isClosing ref guard
- `src/components/Dialogs/UnsavedChangesDialog.tsx` - verify it respects closing state
## Implementation

### 1. Fix SurveyLayer.tsx `destroy()` method

Import the helper:
```typescript
import { hasLiveStyle } from './mapUtils';
```

Update destroy method:
```typescript
public destroy(): void {
  // Guard against map being destroyed
  if (!hasLiveStyle(this.map)) return;
  
  try {
    // Remove event listeners first
    this.map.off('mouseenter', this.stationsLayerId, this.onStationMouseEnter);
    // ... other event listener removals
    
    // Remove layers and sources
    if (this.map.getLayer(this.stationsLayerId)) {
      this.map.removeLayer(this.stationsLayerId);
    }
    if (this.map.getLayer(this.shotsLayerId)) {
      this.map.removeLayer(this.shotsLayerId);
    }
    if (this.map.getSource(this.sourceId)) {
      this.map.removeSource(this.sourceId);
    }
  } catch {
    // Map already destroyed, cleanup not needed
  }
}
```

### 2. Repo-wide search for cleanup patterns

Run these searches to find any other cleanup code that needs guards:

```bash
# Find all map.getLayer calls
rg "map\.getLayer\(" src/components/Map/ --type ts --type tsx

# Find all map.getSource calls  
rg "map\.getSource\(" src/components/Map/ --type ts --type tsx

# Find all removeLayer/removeSource calls
rg "(removeLayer|removeSource)" src/components/Map/ --type ts --type tsx

# Look for cleanup effects with map operations
rg "return \(\) =>" src/components/Map/ -A 10
```

### 3. Add rapid Back click guard

In `src/hooks/useProject.ts`, add closing state guard:

```typescript
const [isClosing, setIsClosing] = useState(false);

const handleCloseProject = useCallback(async () => {
  // Prevent concurrent close operations
  if (isClosing) return;
  
  if (isDirty) {
    openUnsavedChangesDialog();
    return;
  }
  
  setIsClosing(true);
  try {
    await closeProject();
    setView('global');
  } finally {
    setIsClosing(false);
  }
}, [isClosing, isDirty, openUnsavedChangesDialog, closeProject, setView]);
```

Also ensure the UnsavedChangesDialog respects this guard.

### 4. Files to check

- `src/components/Map/SurveyLayer.tsx` - `destroy()` method
- `src/components/Map/GridOverlay.tsx` - already fixed in task 1
- `src/components/Map/MapCanvas.tsx` - verify cleanup order
- `src/hooks/useProject.ts` - add isClosing guard
- `src/components/Dialogs/UnsavedChangesDialog.tsx` - verify it respects closing state
## Objective

After fixing GridOverlay, audit all other map overlay components for similar cleanup issues where they might access the map after it's been destroyed.

## Components to Audit

1. **SurveyLayer.ts** (`src/components/Map/SurveyLayer.ts`)
   - Check `destroy()` method
   - Check any useEffect cleanup functions that use the map

2. **PlacementOverlay.tsx** (`src/components/Map/PlacementOverlay.tsx`)
   - Check for any map access during unmount

3. **MapCanvas.tsx** (`src/components/Map/MapCanvas.tsx`)
   - Check all useEffect cleanup functions
   - Ensure proper cleanup order

## Pattern to Look For

Any code that calls these methods without checking `map.style`:
- `map.getLayer()`
- `map.getSource()`
- `map.removeLayer()`
- `map.removeSource()`
- `map.setPaintProperty()`
- `map.setLayoutProperty()`
- Any other MapLibre style operations

## Fix Pattern

```typescript
// Before
if (map.getLayer(layerId)) {
  map.removeLayer(layerId);
}

// After
if (map && map.style && map.getLayer(layerId)) {
  map.removeLayer(layerId);
}
```

## Verification

1. Click Back from various states (dirty, clean, during loading)
2. No console errors
3. All tests pass
## Acceptance
- [ ] SurveyLayer.tsx imports `hasLiveStyle` from mapUtils
- [ ] SurveyLayer `destroy()` guards with `if (!hasLiveStyle(this.map)) return`
- [ ] SurveyLayer `destroy()` wraps map operations in try/catch
- [ ] Repo-wide search completed for getLayer/getSource in cleanup code
- [ ] All found instances either have guards or don't need them (documented why)
- [ ] Rapid Back click guard implemented using useRef (NOT useState)
- [ ] Guard prevents concurrent close operations without unmount warnings
- [ ] UnsavedChangesDialog respects closing guard
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
