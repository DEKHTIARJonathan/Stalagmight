# fn-3-e6v.5 Clear selection and cancel operations when visibility changes

## Description
Add selection actions and clear selection on visibility changes.

## `src/store/uiStore.ts` - New actions

```typescript
clearSelectionByType: (type) => { ... },
filterSelection: (predicate) => { ... },
```

## `src/components/Map/MapCanvas.tsx` - Effects

**showStations OFF:**
```typescript
useEffect(() => {
  if (!showStations) {
    clearSelectionByType('station');
    setHoveredStation(null);
    surveyLayerRef.current?.clearAllInteractionState();
  }
}, [showStations]);
```

**showShots OFF:**
```typescript
useEffect(() => {
  if (!showShots) {
    clearSelectionByType('shot');
    setHoveredShot(null);
    surveyLayerRef.current?.clearShotHover();
  }
}, [showShots]);
```

**showVirtualShots OFF - use stable dependency:**
```typescript
const { project } = useProjectStore();
const projectId = project?.id;

useEffect(() => {
  if (!showVirtualShots && project?.sections) {
    filterSelection((s) => {
      if (s.type !== 'shot') return true;
      const section = project.sections.find(sec => sec.id === s.sectionId);
      const shot = section?.shots.find(sh => sh.id === s.shotId);
      return !shot?.is_virtual;
    });
    surveyLayerRef.current?.clearShotHover();
  }
}, [showVirtualShots, projectId]);  // projectId is stable
```
## Files to Modify

### `src/store/uiStore.ts` - Add new actions

```typescript
clearSelectionByType: (type: 'station' | 'shot' | 'section') => {
  const current = get();
  set({
    selection: current.selection?.type === type ? null : current.selection,
    multiSelection: current.multiSelection.filter(s => s.type !== type),
  });
},

filterSelection: (predicate: (s: Selection) => boolean) => {
  const current = get();
  set({
    selection: current.selection && predicate(current.selection) ? current.selection : null,
    multiSelection: current.multiSelection.filter(predicate),
  });
},
```

### `src/components/Map/MapCanvas.tsx` - Visibility change effects

**When showStations OFF:**
```typescript
useEffect(() => {
  if (!showStations) {
    clearSelectionByType('station');
    setHoveredStation(null);
    surveyLayerRef.current?.clearAllInteractionState();
    // Cancel operations with toast...
  }
}, [showStations]);
```

**When showShots OFF:**
```typescript
useEffect(() => {
  if (!showShots) {
    clearSelectionByType('shot');
    setHoveredShot(null);
    surveyLayerRef.current?.clearShotHover();
  }
}, [showShots]);
```

**When showVirtualShots OFF:**
```typescript
const { project } = useProjectStore();

useEffect(() => {
  if (!showVirtualShots) {
    if (!project?.sections) return;  // Guard for null
    filterSelection((s) => {
      if (s.type !== 'shot') return true;
      const section = project.sections.find(sec => sec.id === s.sectionId);
      const shot = section?.shots.find(sh => sh.id === s.shotId);
      return !shot?.is_virtual;
    });
    surveyLayerRef.current?.clearShotHover();
  }
}, [showVirtualShots, project?.sections]);
```
## Files to Modify

### `src/store/uiStore.ts`

Add `filterSelection` action:
```typescript
filterSelection: (predicate: (s: Selection) => boolean) => {
  const current = get();
  set({
    selection: current.selection && predicate(current.selection) ? current.selection : null,
    multiSelection: current.multiSelection.filter(predicate),
  });
},
```

### `src/components/Map/MapCanvas.tsx`

**Access project data correctly:**
```typescript
const { project } = useProjectStore();  // NOT { sections }
```

**When showStations OFF:**
```typescript
useEffect(() => {
  if (!showStations && surveyLayerRef.current) {
    surveyLayerRef.current.clearAllInteractionState();
    clearSelectionByType('station');
    // Cancel operations...
  }
}, [showStations]);
```

**When showShots OFF - clear ALL shot selections:**
```typescript
useEffect(() => {
  if (!showShots) {
    clearSelectionByType('shot');  // Clears ALL shots
    surveyLayerRef.current?.clearShotHover();
    setHoveredShot(null);
  }
}, [showShots]);
```

**When showVirtualShots OFF - filter virtual shots:**
```typescript
useEffect(() => {
  if (!showVirtualShots && project?.sections) {
    // Filter out virtual shots from selection
    filterSelection((s) => {
      if (s.type !== 'shot') return true;
      const section = project.sections.find(sec => sec.id === s.sectionId);
      const shot = section?.shots.find(sh => sh.id === s.shotId);
      return !shot?.is_virtual;  // Keep non-virtual
    });
    surveyLayerRef.current?.clearShotHover();
  }
}, [showVirtualShots, project?.sections]);
```
## Files to Modify

### `src/store/uiStore.ts`

Add in-memory state and clearSelectionByType as before.

### `src/components/Map/MapCanvas.tsx`

**Clear virtual shot selection using project data:**

```typescript
const { sections } = useProjectStore();

useEffect(() => {
  if (!showStations && surveyLayerRef.current) {
    surveyLayerRef.current.clearAllInteractionState();
    clearSelectionByType('station');
    // ... cancel operations
  }
}, [showStations]);

useEffect(() => {
  if (!showShots && surveyLayerRef.current) {
    surveyLayerRef.current.clearShotHover();
    clearSelectionByType('shot');
  }
}, [showShots]);

// Virtual shots - check project data for virtuality
useEffect(() => {
  if (!showVirtualShots) {
    // Clear virtual shot selection
    if (selection?.type === 'shot') {
      const section = sections.find(s => s.id === selection.sectionId);
      const shot = section?.shots.find(sh => sh.id === selection.shotId);
      if (shot?.isVirtual) {
        clearSelection();
      }
    }
    // Clear multiSelection of virtual shots
    const virtualShotRefs = multiSelection.filter(s => {
      if (s.type !== 'shot') return false;
      const section = sections.find(sec => sec.id === s.sectionId);
      const shot = section?.shots.find(sh => sh.id === s.shotId);
      return shot?.isVirtual;
    });
    if (virtualShotRefs.length > 0) {
      // Filter out virtual shots from multiSelection
      // (may need new action or filter logic)
    }
    surveyLayerRef.current?.clearVirtualShotState();
  }
}, [showVirtualShots, sections]);
```
## Files to Modify

### `src/store/uiStore.ts`

**Add in-memory state:**
```typescript
_prevShowVirtualShots: boolean | null;
_prevShowShotData: boolean | null;
```

**Add clearSelectionByType:**
```typescript
clearSelectionByType: (type: 'station' | 'shot' | 'section') => {
  const current = get();
  set({
    selection: current.selection?.type === type ? null : current.selection,
    multiSelection: current.multiSelection.filter(s => s.type !== type),
  });
},
```

**Update toggleDisplay for cascade:**
```typescript
toggleDisplay: (key) => {
  if (key === 'showShots') {
    const newVal = !get().showShots;
    if (!newVal) {
      set({
        showShots: false,
        _prevShowVirtualShots: get().showVirtualShots,
        _prevShowShotData: get().showShotData,
        showShotData: false,
      });
    } else {
      set({
        showShots: true,
        showVirtualShots: get()._prevShowVirtualShots ?? get().showVirtualShots,
        showShotData: get()._prevShowShotData ?? get().showShotData,
      });
    }
  } else {
    set({ [key]: !get()[key] });
  }
}
```

### `src/components/Map/MapCanvas.tsx`

**Use clearAllInteractionState for comprehensive cleanup:**

```typescript
useEffect(() => {
  if (!showStations && surveyLayerRef.current) {
    // Clear ALL SurveyLayer internal state to prevent stale visuals
    surveyLayerRef.current.clearAllInteractionState();
    // Clear store state
    clearSelectionByType('station');
    setHoveredStation(null);
    // Cancel operations
    if (drawFromStation || mergeStationA || placementMode) {
      showToast('Operation canceled - stations hidden', 'operation-canceled');
    }
    setDrawFromStation(null);
    setMergeStationA(null);
    setMergeStationB(null);
    setSnappedStation(null);
    if (placementMode) setPlacementMode(false);
  }
}, [showStations]);

useEffect(() => {
  if (!showShots && surveyLayerRef.current) {
    surveyLayerRef.current.clearShotHover();
    clearSelectionByType('shot');
    setHoveredShot(null);
  }
}, [showShots]);

// Handle virtual shots toggle
useEffect(() => {
  if (!showVirtualShots && surveyLayerRef.current) {
    // Clear any virtual shot hover/selection
    // This may require checking if current selection is virtual
    surveyLayerRef.current.clearShotHover();
  }
}, [showVirtualShots]);
```
## Files to Modify

### `src/store/uiStore.ts`

**Add in-memory state (NOT persisted):**
```typescript
// These are NOT persisted - purely in-memory
_prevShowVirtualShots: boolean | null;
_prevShowShotData: boolean | null;
```

**Add clearSelectionByType action:**
```typescript
clearSelectionByType: (type: 'station' | 'shot' | 'section') => {
  const current = get();
  set({
    selection: current.selection?.type === type ? null : current.selection,
    multiSelection: current.multiSelection.filter(s => s.type !== type),
  });
},
```

**Update toggleDisplay for cascade:**
```typescript
toggleDisplay: (key) => {
  const prev = get()[key];
  const newVal = !prev;
  
  if (key === 'showShots') {
    if (!newVal) {
      // Store previous values IN MEMORY (not persisted)
      set({
        showShots: false,
        _prevShowVirtualShots: get().showVirtualShots,
        _prevShowShotData: get().showShotData,
        showShotData: false, // Hide labels immediately
      });
    } else {
      // Restore from in-memory values
      set({
        showShots: true,
        showVirtualShots: get()._prevShowVirtualShots ?? get().showVirtualShots,
        showShotData: get()._prevShowShotData ?? get().showShotData,
      });
    }
  } else {
    set({ [key]: newVal });
  }
}
```

### `src/components/Map/MapCanvas.tsx`

**Add visibility change effects:**
```typescript
useEffect(() => {
  if (!showStations) {
    clearSelectionByType('station');
    setHoveredStation(null);
    surveyLayerRef.current?.clearStationHover();
    surveyLayerRef.current?.clearSnappedStation();
    
    // Cancel station operations with toast
    if (drawFromStation || mergeStationA || placementMode) {
      showToast('Operation canceled - stations hidden', 'operation-canceled');
    }
    setDrawFromStation(null);
    setMergeStationA(null);
    setMergeStationB(null);
    setSnappedStation(null);
    if (placementMode) setPlacementMode(false);
  }
}, [showStations]);

useEffect(() => {
  if (!showShots) {
    clearSelectionByType('shot');
    setHoveredShot(null);
    surveyLayerRef.current?.clearShotHover();
  }
}, [showShots]);
```
## Files to Modify

### `src/store/uiStore.ts`

**Add new actions:**

```typescript
// Clear selections of a specific type
clearSelectionByType: (type: 'station' | 'shot' | 'section') => {
  const current = get();
  set({
    selection: current.selection?.type === type ? null : current.selection,
    multiSelection: current.multiSelection.filter(s => s.type !== type),
  });
},
```

**Update toggleDisplay for cascade:**
```typescript
toggleDisplay: (key) => {
  const prev = get()[key];
  const newVal = !prev;
  
  if (key === 'showShots') {
    if (!newVal) {
      // Store previous values before disabling
      set({
        showShots: false,
        _prevShowVirtualShots: get().showVirtualShots,
        _prevShowShotData: get().showShotData,
        showShotData: false, // Hide labels immediately
      });
    } else {
      // Restore previous values
      set({
        showShots: true,
        showVirtualShots: get()._prevShowVirtualShots ?? true,
        showShotData: get()._prevShowShotData ?? false,
      });
    }
  } else {
    set({ [key]: newVal });
  }
}
```

### `src/components/Map/MapCanvas.tsx`

Add useEffect hooks:
```typescript
useEffect(() => {
  if (!showStations) {
    clearSelectionByType('station');
    setHoveredStation(null);
    surveyLayerRef.current?.clearStationHover();
    // Cancel station operations
    if (drawFromStation || mergeStationA || placementMode) {
      showToast('Operation canceled - stations hidden', 'operation-canceled');
    }
    setDrawFromStation(null);
    setMergeStationA(null);
    setMergeStationB(null);
    setSnappedStation(null);
    if (placementMode) setPlacementMode(false);
  }
}, [showStations]);

useEffect(() => {
  if (!showShots) {
    clearSelectionByType('shot');
    setHoveredShot(null);
    surveyLayerRef.current?.clearShotHover();
  }
}, [showShots]);
```
## Files to Modify

### `src/store/uiStore.ts`

**Selection state (L50, L279):**
- `selection: Selection | null` - single selection
- `multiSelection: Selection[]` - multi-selection
- `clearSelection()` - clears both

**Operation state to clear:**
- `drawFromStation: StationId | null` (draw origin)
- `mergeStationA: StationId | null`, `mergeStationB: StationId | null` (merge targets)
- `measureStart: Coordinates | null`, `measureEnd: Coordinates | null` (measure points)
- `placementMode: boolean` (placement state)
- `snappedStation: StationId | null` (snap state)
- `hoveredStation: StationId | null`, `hoveredShot: ShotId | null` (hover state)

### `src/components/Map/MapCanvas.tsx`

Add useEffect hooks to respond to visibility changes:

```typescript
// Clear station-related state when stations hidden
useEffect(() => {
  if (!showStations) {
    // Clear station selections
    const stationSelections = multiSelection.filter(s => s.type === 'station');
    if (selection?.type === 'station' || stationSelections.length > 0) {
      clearStationSelections(); // new action or filter logic
    }
    // Cancel station-related operations
    cancelStationOperations(); // clears draw, merge, snap state
    // Clear hover
    if (hoveredStation) setHoveredStation(null);
    // Show toast if operation was canceled
    if (drawFromStation || mergeStationA || placementMode) {
      showToast('Operation canceled - stations hidden');
    }
  }
}, [showStations]);

// Similar for shots...
```

## Implementation Notes

- May need new action `clearStationSelections()` that filters `multiSelection` by type
- Or modify existing `clearSelection()` to accept optional type filter
- Check if any operation was in progress before showing cancellation toast
## Files to Modify
- `src/components/Map/MapCanvas.tsx` or relevant hook
- Potentially `src/hooks/useMapTools.ts`

## Implementation Details

### Clear Selection on Toggle
When `showStations` changes from true to false:
- Clear any selected stations from the selection state
- Keep any selected shots (if shots are still visible)

When `showShots` changes from true to false:
- Clear any selected shots from the selection state
- Keep any selected stations (if stations are still visible)

### Cancel In-Progress Operations
When visibility toggles change during an active tool operation:
- Cancel Draw operation (clear pending points)
- Cancel Merge operation (clear selected merge targets)
- Cancel Measure operation (clear measurement points)
- Show toast notification: "Operation canceled - [stations/shots] hidden"

## Depends On
- Task 3: Visibility toggle wiring must be in place
## Acceptance
- [ ] `clearSelectionByType` and `filterSelection` actions added
- [ ] `setHoveredStation(null)` called when stations hidden
- [ ] `setHoveredShot(null)` called when shots hidden
- [ ] Virtual shot effect uses `projectId` dependency (stable)
- [ ] `pnpm tsc --noEmit` passes
## Done summary
Added clearSelectionByType and filterSelection actions to uiStore. Implemented useEffect hooks in MapCanvas to clear selection, hover state, and cancel station operations (merge, measure, draw, placement) when visibility toggles are disabled.
## Evidence
- Commits: c7bb091, a0d0122, eab965d, 404c098, 7492d27
- Tests: pnpm tsc --noEmit, pnpm test:ui
- PRs: