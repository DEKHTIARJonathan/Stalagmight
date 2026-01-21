# fn-12-szd.3 Implement fitToSection in MapCanvas

## Description
Implement the core `fitToSection()` method in MapCanvas that zooms the map to show a specific section at ~80% of visible area, accounting for open side panels.

**Size:** M
**Files:** `src/components/Map/MapCanvas.tsx`

## Approach

- Follow existing `fitToBounds()` pattern at `src/components/Map/MapCanvas.tsx:1130-1150`
- Watch `requestZoomToSection` from UIStore via useEffect
- **CRITICAL**: Always call `clearZoomToSectionRequest()` at the start of the handler, before any early returns, to prevent stuck requests
- Filter stations by `section_id` to get section geometry
- Use `getBounds()` from `src/utils/coordinates.ts:118` for bounds calculation
- Use `metersToMapCoords(x, y, gpsOrigin)` for coordinate transformation - **must pass gpsOrigin for satellite alignment**
- Calculate padding from UIStore panel state:
  - Left padding: `sectionsPanelOpen ? sectionsPanelWidth : 0`
  - Right padding: `detailPanelOpen ? detailPanelWidth : 0`
  - Top/Bottom: 10% of container height
- Call `map.stop()` before `map.fitBounds()` to cancel any running animation
- Handle edge cases:
  - Single station: use `map.easeTo()` with `point_zoom` from config
  - Empty section (0 stations): clear request and return early
- Respect `config.map.animation.enabled` and `duration` settings

## Key context

- MapLibre padding accumulation bug: call `map.setPadding({top:0,right:0,bottom:0,left:0})` before fitBounds
- Use `linear: true` in fitBounds options for easeTo behavior
- Panel state available from UIStore: `sectionsPanelOpen`, `sectionsPanelWidth`, `detailPanelOpen`, `detailPanelWidth`
- gpsOrigin available from projectStore for coordinate transformation
## Approach

- Follow existing `fitToBounds()` pattern at `src/components/Map/MapCanvas.tsx:1130-1150`
- Watch `requestZoomToSection` from UIStore via useEffect
- Filter stations by `section_id` to get section geometry
- Use `getBounds()` from `src/utils/coordinates.ts:118` for bounds calculation
- Use `metersToMapCoords()` for coordinate transformation
- Calculate padding: read panel widths from UIStore/DOM, add 10% margin
- Call `map.stop()` before `map.fitBounds()` to cancel any running animation
- Handle edge cases:
  - Single station: use `map.easeTo()` with `point_zoom` from config
  - Empty section (0 stations): no-op, just clear request
- Respect `config.map.animation.enabled` and `duration` settings

## Key context

- MapLibre padding accumulation bug: call `map.setPadding({top:0,right:0,bottom:0,left:0})` before fitBounds
- Use `linear: true` in fitBounds options for easeTo behavior
- Panel widths available from UIStore: `sectionsPanelWidth`, `detailPanelWidth`
## Acceptance
- [ ] `fitToSection(sectionId)` method implemented in MapCanvas
- [ ] useEffect watches `requestZoomToSection` and calls `fitToSection`
- [ ] `clearZoomToSectionRequest()` called immediately (before any early returns)
- [ ] Stations filtered by section_id correctly
- [ ] gpsOrigin passed to `metersToMapCoords` for satellite alignment
- [ ] Padding uses UIStore: `sectionsPanelOpen/Width`, `detailPanelOpen/Width`
- [ ] `map.stop()` called before starting new animation
- [ ] `map.setPadding({...0s})` called before fitBounds (padding bug workaround)
- [ ] Single-station sections center at `point_zoom` level
- [ ] Empty sections handled gracefully (clear request, return early)
- [ ] Animation respects config.map.animation settings
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
