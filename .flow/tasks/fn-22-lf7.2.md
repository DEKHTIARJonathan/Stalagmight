# fn-22-lf7.2 Add MapCanvas hoveredStation sync

## Description

Add a useEffect to MapCanvas that syncs `hoveredStation` from uiStore to SurveyLayer, enabling external components (like DetailLink) to highlight stations on the map by calling uiStore.setHoveredStation.

**Size:** S
**Files:** `src/components/Map/MapCanvas.tsx`

## Approach

Follow the pattern at `src/components/Map/MapCanvas.tsx:707-722`:

1. Add `hoveredStation` to the uiStore destructure (around line 61)
2. Add new useEffect that calls `surveyLayerRef.current.setHoveredStation(hoveredStation)`
3. Include `mapLoaded` in deps (per memory pitfall: "useEffect syncing to SurveyLayer needs mapLoaded in deps")
4. Guard with `if (!surveyLayerRef.current) return`

## Key Context

- Existing pattern at lines 709-712 for hoveredSectionId
- Existing pattern at lines 716-722 for hoveredShot
- Memory pitfall: include mapLoaded in deps to re-run when SurveyLayer becomes available
## Acceptance
- [ ] useEffect syncs hoveredStation from uiStore to SurveyLayer.setHoveredStation
- [ ] Includes mapLoaded in dependencies
- [ ] Guards against null surveyLayerRef
- [ ] Calling uiStore.setHoveredStation(ref) results in station highlighting on map
- [ ] Calling uiStore.setHoveredStation(null) clears station highlight
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
