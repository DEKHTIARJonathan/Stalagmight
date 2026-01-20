# fn-9-d6v.8 Add bidirectional map-to-panel hover sync

## Description
Add bidirectional map-to-panel hover sync (hovering map features highlights section in panel).

## Files to Modify

### `src/components/Map/MapCanvas.tsx`

**In existing hover callbacks, derive section and set hoveredSectionId:**

The existing `onStationHover` and `onShotHover` callbacks from SurveyLayer already provide the data needed. We need to derive sectionId and call `setHoveredSectionId`.

**Option A: Extend existing callbacks (preferred)**
In `useMapTools.ts` or wherever hover callbacks are handled:
```typescript
// When station is hovered, derive section from StationRef
const handleStationHover = (stationRef: StationRef | null) => {
  // ... existing logic
  setHoveredSectionId(stationRef?.section_id ?? null);
};

// When shot is hovered, sectionId is already in the hover data
const handleShotHover = (shot: { sectionId: SectionId; shotId: ShotId } | null) => {
  // ... existing logic
  setHoveredSectionId(shot?.sectionId ?? null);
};
```

**Option B: New effect watching existing hover states**
```typescript
// Derive hoveredSectionId from individual hover states
useEffect(() => {
  if (hoveredStation) {
    setHoveredSectionId(hoveredStation.section_id);
  } else if (hoveredShot) {
    setHoveredSectionId(hoveredShot.sectionId);
  } else {
    // Only clear if the section hover wasn't set by panel
    // This might need source tracking - keep it simple for now
    setHoveredSectionId(null);
  }
}, [hoveredStation, hoveredShot]);
```

## Clear Behavior
When mouse leaves ALL features (moves to empty map space), hoveredSectionId should clear immediately. The SurveyLayer mouse event handlers already call with `null` on mouseleave.

## Panel Response
The SectionsPanel already reads `hoveredSectionId` from uiStore (from task 6), so when map sets it, panel row highlights automatically.
## Acceptance
- [ ] Hovering station on map sets hoveredSectionId (derived from StationRef.section_id)
- [ ] Hovering shot on map sets hoveredSectionId (from shot.sectionId)
- [ ] Leaving all features clears hoveredSectionId to null
- [ ] SectionsPanel row highlights when its section is hovered on map
- [ ] No debounce needed (per interview decision)
- [ ] Clear is immediate when mouse leaves features
- [ ] Works with stations AND shots (both derive section)
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
