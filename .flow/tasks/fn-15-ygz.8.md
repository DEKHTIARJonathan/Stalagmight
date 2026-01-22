# fn-15-ygz.8 Implement soft bounds with rubber-band panning

## Description
Implement soft bounds with rubber-band panning. Users can pan outside system bounds but experience gentle resistance that pulls back to valid area.

**Size:** S
**Files:** 
- `src/components/GlobalView/GlobalViewMap.tsx` (transformConstrain callback)

## Approach

- Use MapLibre's `transformConstrain` option
- Calculate combined bounds of all systems + 20% padding
- When panning outside bounds, apply progressive resistance
- Gentle snap-back when released (not instant)
- Fit All button zooms to all systems with GPS

## Key context

- Pattern from MapLibre docs: `transformConstrain: (lngLat, zoom) => constrainedResult`
- 20% padding means: if systems span 10 degrees, allow 12 degrees total
## Acceptance
- [ ] Can pan slightly outside system bounds
- [ ] Panning outside feels resistance (progressive)
- [ ] Released pan smoothly returns toward bounds
- [ ] Fit All button works and zooms to all systems
- [ ] 20% padding around combined system bounds
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
