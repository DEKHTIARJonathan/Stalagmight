# fn-9-d6v.8 Add bidirectional map-to-panel hover sync

## Description
Add bidirectional map-to-panel hover sync (hovering map features highlights section in panel).

## Files to Modify

### `src/hooks/useMapTools.ts` (or wherever hover callbacks are handled)

**Extend existing hover callbacks to also set hoveredSectionId:**

The existing `handleStationHover` and `handleShotHover` callbacks already receive the relevant data. We need to derive sectionId and call `setHoveredSectionId`.

**Pattern:**
```typescript
// When station is hovered
const handleStationHover = (stationRef: StationRef | null) => {
  // ... existing logic (setHoveredStation, etc.)
  
  // Derive section and set for panel highlight
  setHoveredSectionId(stationRef?.section_id ?? null);
};

// When shot is hovered
const handleShotHover = (shot: { sectionId: SectionId; shotId: ShotId } | null) => {
  // ... existing logic (setHoveredShot, etc.)
  
  // Derive section and set for panel highlight
  setHoveredSectionId(shot?.sectionId ?? null);
};
```

**CRITICAL: Clear behavior**
When callbacks are called with `null` (mouse leaves feature), `setHoveredSectionId(null)` is called to clear the panel highlight:
- `handleStationHover(null)` → `setHoveredSectionId(null)`
- `handleShotHover(null)` → `setHoveredSectionId(null)`

This happens automatically via the `?? null` fallback in the pattern above.

## Alternative: Effect-based sync

If modifying useMapTools is complex, use an effect in MapCanvas:
```typescript
// Derive hoveredSectionId from individual hover states
useEffect(() => {
  if (hoveredStation) {
    setHoveredSectionId(hoveredStation.section_id);
  } else if (hoveredShot) {
    setHoveredSectionId(hoveredShot.sectionId);
  } else {
    setHoveredSectionId(null);  // Clear when no hover
  }
}, [hoveredStation, hoveredShot, setHoveredSectionId]);
```

## Panel Response
The SectionsPanel already reads `hoveredSectionId` from uiStore (from task 6), so when map sets it, panel row highlights automatically via the conditional class.
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
- [ ] `handleStationHover(null)` clears hoveredSectionId to null
- [ ] `handleShotHover(null)` clears hoveredSectionId to null
- [ ] SectionsPanel row highlights when its section is hovered on map
- [ ] No debounce needed (per interview decision)
- [ ] Clear is immediate when mouse leaves features
- [ ] Works with both stations AND shots
- [ ] Uses either callback extension or effect-based approach
- [ ] `pnpm tsc --noEmit` passes
## Done summary
Added bidirectional map-to-panel hover sync: hovering stations/shots on the map now highlights the corresponding section row in SectionsPanel. Section hover styling is visually distinct from individual hover (reduced width/different color), and flicker is prevented during feature transitions by conditionally clearing hoveredSectionId.
## Evidence
- Commits: 310ced7aa0d1a0d94fb2afca4ba68f1b04a23b37, 235578a8eea17272f1fb2626f2785b3dd99504c5
- Tests: pnpm tsc --noEmit
- PRs: