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
- Add `fitToStation(stationRef: StationRef)` - use `easeTo()` with `point_zoom` config
- Add `fitToShot(sectionId, shotId)` - calculate shot midpoint, use `easeTo()`
- Wire up `useEffect` to listen to `requestCenterOnStation` and `requestCenterOnShot`

## Key context
- Single point centering uses `easeTo()` not `fitBounds()` (see L1241-1248)
- Use `mapConfig.point_zoom` for zoom level when centering on single point
- Shot midpoint = average of start and end station coordinates
## Acceptance
- [ ] uiStore has `requestCenterOnStation`, `triggerCenterOnStation`, `clearCenterOnStationRequest`
- [ ] uiStore has `requestCenterOnShot`, `triggerCenterOnShot`, `clearCenterOnShotRequest`
- [ ] MapCanvas has `fitToStation()` that centers map on station coordinates
- [ ] MapCanvas has `fitToShot()` that centers map on shot midpoint
- [ ] Both use `easeTo()` with smooth animation
- [ ] useEffect hooks respond to request state changes
- [ ] Unit tests for uiStore actions
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
