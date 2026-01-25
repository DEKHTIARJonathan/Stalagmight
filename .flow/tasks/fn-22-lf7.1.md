# fn-22-lf7.1 Add SurveyLayer.setHoveredStation method

## Description

Add a public `setHoveredStation(stationRef: StationRef | null)` method to SurveyLayer that allows external components to set the hovered station (mirroring the existing `setHoveredSection` and `setHoveredShot` patterns).

**Size:** S
**Files:** `src/components/Map/SurveyLayer.tsx`

## Approach

Follow the pattern at `src/components/Map/SurveyLayer.tsx:1282-1300` (setHoveredSection, setHoveredShot):

1. Add public method `setHoveredStation(stationRef: StationRef | null): void`
2. Convert StationRef to internal string ID format (`${section_id}:${station_index}`)
3. Early return if ID hasn't changed (like line 1285)
4. Set `this.hoveredStationId`
5. Call `this.updateVisualState()`

## Key Context

- Internal `hoveredStationId` format is `"sectionId:stationIndex"` string (0-indexed)
- `StationRef` has `section_id: SectionId` and `station_index: number`
- Pattern: `setHoveredSection` takes `SectionId | null`, `setHoveredShot` takes `(SectionId | null, ShotId | null)`
## Acceptance
- [ ] `SurveyLayer.setHoveredStation(ref)` method exists and is public
- [ ] Passing a StationRef highlights that station using existing hover style
- [ ] Passing null clears station hover highlight
- [ ] Calling with same station twice doesn't re-render (early return on no change)
- [ ] Works with existing map-based station hover (both paths set same internal state)
## Done summary
Added public setHoveredStation(ref: StationRef | null) method to SurveyLayer that allows external components to set the hovered station, mirroring existing setHoveredSection and setHoveredShot patterns.
## Evidence
- Commits: dfefe867e980c159cbc294b2c380c2717ae1c360
- Tests: pnpm tsc --noEmit, pnpm test:ui
- PRs: