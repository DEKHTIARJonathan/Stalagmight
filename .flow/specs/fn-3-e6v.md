# Display Toggle Visibility & Selection Behavior

## Problem

The "Display → Stations" toggle exists in the UI but does not hide station markers or prevent selection.

## Key Files

| File | Purpose |
|------|---------|
| `src/store/uiStore.ts` | Toggle state, selection actions, resetDisplaySettings() |
| `src/components/Map/SurveyLayer.tsx` | Layer visibility, sources |
| `src/components/Map/MapCanvas.tsx` | Toggle sync, highlight wiring |
| `src/components/SingleSystemView/DisplayMenu.tsx` | Toggle UI |
| `src/hooks/useMapTools.ts` | Tool handlers |
| `e2e-playwright/mocks/tauri-ipc.ts` | Playwright mocks |

## Approach

### Adding `showShots` Toggle - Complete Checklist

1. **`src/store/uiStore.ts`:**
   - Add `showShots: boolean` to UIState interface
   - Add `'showShots'` to `DisplayToggleKey` union
   - Add `showShots: true` to initial state defaults
   - **Add `showShots: true` to `resetDisplaySettings()`**
   - Persistence works automatically

2. **`src/components/SingleSystemView/DisplayMenu.tsx`:**
   - Add to displayOptions before "Virtual Shots"

3. **`src/components/Map/MapCanvas.tsx`:**
   - Destructure `showShots`
   - Add useEffect sync to SurveyLayer

4. **`e2e-playwright/mocks/tauri-ipc.ts`:**
   - Add `showShots: true` to mock

### New Store Actions

```typescript
clearSelectionByType: (type: 'station' | 'shot' | 'section') => { ... },
filterSelection: (predicate: (s: Selection) => boolean) => { ... },
```

### Station Highlight Layer

**Source**: `survey-data-stations`

**Wiring in MapCanvas:**
```typescript
useEffect(() => {
  if (!surveyLayerRef.current) return;
  
  const highlightIds: string[] = [];
  if (snappedStation) highlightIds.push(snappedStation);
  if (drawFromStation && !highlightIds.includes(drawFromStation)) {
    highlightIds.push(drawFromStation);
  }
  if (mergeStationA && !highlightIds.includes(mergeStationA)) {
    highlightIds.push(mergeStationA);
  }
  if (mergeStationB && !highlightIds.includes(mergeStationB)) {
    highlightIds.push(mergeStationB);
  }
  
  surveyLayerRef.current.setHighlightedStations(highlightIds);
}, [snappedStation, drawFromStation, mergeStationA, mergeStationB, mapLoaded]);
```

### Selection Clearing

**When `showStations` OFF:**
```typescript
useEffect(() => {
  if (!showStations) {
    clearSelectionByType('station');
    setHoveredStation(null);
    surveyLayerRef.current?.clearAllInteractionState();
  }
}, [showStations]);
```

**When `showShots` OFF:**
- Clear ALL shot selections
- Clear hover
- **Shot labels (`showShotData`) cascade off** (already specified in toggle cascade)

```typescript
useEffect(() => {
  if (!showShots) {
    clearSelectionByType('shot');
    setHoveredShot(null);
    surveyLayerRef.current?.clearShotHover();
  }
}, [showShots]);
```

**When `showVirtualShots` OFF:**

Use **stable dependency** to avoid repeated re-runs:
```typescript
const { project } = useProjectStore();
const projectId = project?.id;  // Stable primitive

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
}, [showVirtualShots, projectId]);  // Depend on projectId, not sections array
```

### Toggle Cascade

**When `showShots` OFF:**
- Store `_prevShowVirtualShots`, `_prevShowShotData` in-memory
- Set `showShotData = false` (labels cascade off)

### Tool Guards

**Generic `!showStations` guard in handleStationClick applies to ALL station click paths, including merge tool.** No need for separate merge-specific click guard - the generic guard covers it.

**Merge snap guard in handleEmptyClick:**
```typescript
if (activeTool === 'merge' && snappedStation && !showStations) {
  showToast("Enable 'Stations' in Display menu to merge", 'stations-hidden');
  return;
}
```

### DisplayMenu Disabled State

Uses existing button pattern. Add `disabledWhen` to interface.

### Toast System

Per-key throttle (5s), Portal, z-index 99999.

## Quick Commands

```bash
pnpm tsc --noEmit
pnpm test:ui
cargo test --manifest-path src-tauri/Cargo.toml
```

## Acceptance Criteria

- [ ] `showShots` added to resetDisplaySettings()
- [ ] Highlight layer wired to snappedStation/drawFromStation/mergeStationA/B in useEffect
- [ ] Virtual shot effect uses stable `projectId` dependency
- [ ] Shot labels (`showShotData`) cascade off when `showShots` is off
- [ ] Generic station click guard covers merge (no separate merge click guard)
- [ ] Merge snap path has explicit guard
- [ ] E2E and unit tests pass
