# fn-21-q0u.2 Add station/shot centering infrastructure

## Description
Add infrastructure for centering the map on individual stations and shots, extending the existing section zoom pattern.

**Size:** M
**Files:** `src/store/uiStore.ts`, `src/components/Map/MapCanvas.tsx`

## Approach

### uiStore.ts
Follow `triggerZoomToSection` pattern at L149-151:
- Add `requestCenterOnStation: StationRef | null`
- Add `triggerCenterOnStation(ref: StationRef)` action
- Add `clearCenterOnStationRequest()` action
- Same pattern for shots: `requestCenterOnShot: { sectionId: SectionId, shotId: ShotId } | null`

### MapCanvas.tsx
Follow `fitToSection()` pattern at L1186-1262:
- Add `fitToStation(stationRef: StationRef)` - use `easeTo()` with `point_zoom` config (no padding needed for single point)
- Add `fitToShot(sectionId, shotId)` - calculate shot midpoint, use `easeTo()` with `point_zoom` (no padding needed)
- Wire up `useEffect` to listen to `requestCenterOnStation` and `requestCenterOnShot`

### Map Centering Approach
- **Sections**: Use existing `fitBounds()` with padding (multiple points in bounding box)
- **Stations/Shots**: Use `easeTo()` with `point_zoom` config (single point centering, no bounding box, no padding)

### Key context
- Single point centering uses `easeTo()` not `fitBounds()` (see L1241-1248)
- Use `mapConfig.point_zoom` for zoom level when centering on single point
- Shot midpoint = average of start and end station coordinates

## Acceptance
- [ ] uiStore has `requestCenterOnStation`, `triggerCenterOnStation`, `clearCenterOnStationRequest`
- [ ] uiStore has `requestCenterOnShot`, `triggerCenterOnShot`, `clearCenterOnShotRequest`
- [ ] MapCanvas has `fitToStation()` that centers map on station coordinates using `easeTo()`
- [ ] MapCanvas has `fitToShot()` that centers map on shot midpoint using `easeTo()`
- [ ] Both use `point_zoom` config (not fitBounds with padding)
- [ ] useEffect hooks respond to request state changes
- [ ] Vitest unit tests for uiStore actions

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
