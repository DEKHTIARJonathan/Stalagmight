# fn-9-d6v.5 Wire MapCanvas to sync section hover/selection

## Description
Wire MapCanvas to sync section hover/selection between uiStore and SurveyLayer.

## Files to Modify

### `src/components/Map/MapCanvas.tsx`

**Add to store destructure (near L160):**
```typescript
const { selection, hoveredSectionId, setHoveredSectionId } = useUIStore();
```

**Extend existing selection sync effect (L581-595):**
Add section handling to the existing selection sync:
```typescript
useEffect(() => {
  if (!surveyLayerRef.current) return;

  if (selection?.type === 'station' && selection.stationRef) {
    surveyLayerRef.current.setSelectedStation(selection.stationRef);
    surveyLayerRef.current.setSelectedShot(null, null);
    surveyLayerRef.current.setSelectedSection(null);
  } else if (selection?.type === 'shot' && selection.sectionId && selection.shotId) {
    surveyLayerRef.current.setSelectedStation(null);
    surveyLayerRef.current.setSelectedShot(selection.sectionId, selection.shotId);
    surveyLayerRef.current.setSelectedSection(null);
  } else if (selection?.type === 'section' && selection.sectionId) {
    // NEW: Section selection
    surveyLayerRef.current.setSelectedStation(null);
    surveyLayerRef.current.setSelectedShot(null, null);
    surveyLayerRef.current.setSelectedSection(selection.sectionId);
  } else {
    surveyLayerRef.current.setSelectedStation(null);
    surveyLayerRef.current.setSelectedShot(null, null);
    surveyLayerRef.current.setSelectedSection(null);
  }
}, [selection]);
```

**Add new effect for hover sync:**
```typescript
// Sync hoveredSectionId from uiStore to SurveyLayer
useEffect(() => {
  if (!surveyLayerRef.current) return;
  surveyLayerRef.current.setHoveredSection(hoveredSectionId);
}, [hoveredSectionId]);
```

## Why Two Separate Effects
- Selection is a unified state (type + IDs) - one effect handles all selection types
- Hover can come from different sources (panel hover vs map-derived) - separate effect is cleaner
- Follows existing pattern of focused, single-purpose effects
## Acceptance
- [ ] `hoveredSectionId` extracted from useUIStore
- [ ] `setHoveredSectionId` extracted from useUIStore
- [ ] Selection sync effect handles `selection.type === 'section'`
- [ ] Section selection clears station/shot selection on SurveyLayer
- [ ] New hover sync effect watches `hoveredSectionId`
- [ ] Hover sync calls `surveyLayerRef.current.setHoveredSection()`
- [ ] Both effects have null checks for surveyLayerRef.current
- [ ] `pnpm tsc --noEmit` passes
## Done summary
Wired MapCanvas to sync section hover/selection between uiStore and SurveyLayer: extracted hoveredSectionId and setHoveredSectionId from useUIStore, extended the selection sync effect to handle section type (clearing station/shot selection when section is selected), and added a new effect to sync hoveredSectionId to SurveyLayer.setHoveredSection() with mapLoaded dependency for proper initialization.
## Evidence
- Commits: a6c37981f8c5a7f02ef7c6cf36a0b60a3af8b5fb, 97a4f5fae1a3c96d8b3fa0e4cbf95f3e1d0f2a4e, ade76d4c97a6eab6e74b6ca9f287fe1d0ac0d439
- Tests: pnpm tsc --noEmit
- PRs: