# Task 10: Implement Manual Placement Mode

## Description

Implement the manual placement flow where the dialog hides, a ghost outline follows the cursor, and clicking places the section. Includes instruction overlay bar and cancel handling.

## Files to Modify

- `src/components/Dialogs/DmpSectionConfigDialog.tsx`
- `src/components/Map/MapCanvas.tsx`
- `src/components/Map/SurveyLayer.tsx`
- `src/store/uiStore.ts`

## Implementation

### 1. UI Store State

```tsx
interface PlacementModeState {
  active: boolean;
  sectionData: SectionData | null;
  alignStation: 'first' | 'last';
  onComplete: (position: { x: number; y: number }) => void;
  onCancel: () => void;
}

// Add to uiStore
placementMode: PlacementModeState | null;
startPlacementMode: (config: PlacementModeState) => void;
endPlacementMode: () => void;
```

### 2. Dialog Behavior

When "Start Placement" clicked:
1. Save current dialog state
2. Call `startPlacementMode()` with section data
3. Dialog unmounts (closes but state preserved)

```tsx
const handleStartPlacement = () => {
  // Save section config to state
  saveSectionConfig(currentSectionIndex);

  startPlacementMode({
    active: true,
    sectionData: getCurrentSectionData(),
    alignStation: manualAlignStation,
    onComplete: handlePlacementComplete,
    onCancel: handlePlacementCancel,
  });
};

const handlePlacementComplete = (position: { x: number; y: number }) => {
  // Create section at position
  createSectionAtPosition(position);
  // Mark section as placed
  setPlacedSections(prev => new Set(prev).add(currentSectionIndex));
  // Reopen dialog
  reopenDialog();
};

const handlePlacementCancel = () => {
  // Reopen dialog without changes
  reopenDialog();
};
```

### 3. Map Ghost Outline

When placementMode is active in SurveyLayer:

```tsx
// Calculate section outline as GeoJSON
const ghostOutline = useMemo(() => {
  if (!placementMode?.sectionData) return null;

  return calculateSectionOutline(
    placementMode.sectionData.shots,
    mousePosition, // from map hover
    placementMode.alignStation
  );
}, [placementMode, mousePosition]);

// Render ghost layer
{ghostOutline && (
  <Source id="ghost-section" type="geojson" data={ghostOutline}>
    <Layer
      id="ghost-section-line"
      type="line"
      paint={{
        'line-color': placementMode.sectionData.color,
        'line-width': 2,
        'line-opacity': 0.6,
        'line-dasharray': [4, 2],
      }}
    />
    <Layer
      id="ghost-section-stations"
      type="circle"
      paint={{
        'circle-radius': 4,
        'circle-color': placementMode.sectionData.color,
        'circle-opacity': 0.6,
      }}
    />
  </Source>
)}
```

### 4. Instruction Overlay

Display instruction bar at top of map:

```tsx
{placementMode && (
  <div className="absolute top-0 left-0 right-0 bg-panel/90 border-b border-border p-3 text-center z-50">
    <span className="text-text-primary">
      Click to place section. Press <kbd className="px-1 bg-surface rounded">Esc</kbd> or right-click to cancel.
    </span>
  </div>
)}
```

### 5. Event Handlers

```tsx
// In MapCanvas
const handleClick = (e: MapMouseEvent) => {
  if (placementMode) {
    const { lng, lat } = e.lngLat;
    // Convert to local coordinates
    const position = mapToLocalCoords(lng, lat);
    placementMode.onComplete(position);
    endPlacementMode();
    return;
  }
  // Normal click handling...
};

const handleKeyDown = (e: KeyboardEvent) => {
  if (placementMode && e.key === 'Escape') {
    placementMode.onCancel();
    endPlacementMode();
  }
};

const handleContextMenu = (e: MapMouseEvent) => {
  if (placementMode) {
    e.preventDefault();
    placementMode.onCancel();
    endPlacementMode();
    return;
  }
  // Normal context menu...
};
```

### 6. No Rotation

Section keeps original orientation (no rotation during placement per requirements).

## Acceptance Criteria

- [ ] "Start Placement" button hides dialog
- [ ] Ghost outline follows cursor on map
- [ ] Instruction overlay bar visible at top
- [ ] Click on map places section and reopens dialog
- [ ] Escape key cancels and reopens dialog
- [ ] Right-click cancels and reopens dialog
- [ ] Section created at correct position after placement
- [ ] Section marked as placed in left panel
- [ ] TypeScript compiles without errors

## Existing Tests to Modify

The following existing test files must be updated to account for changes made in this task:

### Playwright Tests
- `e2e-playwright/import-dialog.spec.ts` - Manual placement tests need adding/updating for dialog hide/show behavior
- `e2e-playwright/dmp-import.spec.ts` - Import flow tests need updating for manual placement mode

### WebdriverIO Tests
- `e2e/specs/import-dmp-dialog.spec.ts` - Manual placement flow tests need updating
- `e2e/specs/map.spec.ts` - Map interaction during placement may need updates (if exists)

### Mock Updates
- `e2e-playwright/mocks/tauri-ipc.ts` - Add mock handlers for `setSectionOffset` if not present

## Test Suggestions

### Unit Tests (Rust)
1. Test coordinate conversion from map to local
2. Test section position calculation with offset

### Playwright Tests (3-10)
1. Test Start Placement hides dialog
2. Test instruction overlay appears
3. Test ghost outline visible on map (mock)
4. Test Escape key cancels placement
5. Test dialog reopens after cancel
6. Test right-click cancels placement

### WebdriverIO Tests (3-10)
1. Test full manual placement flow
2. Test clicking map places section
3. Test section appears at correct position
4. Test Escape during placement
5. Test continuing to next section after manual placement

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
