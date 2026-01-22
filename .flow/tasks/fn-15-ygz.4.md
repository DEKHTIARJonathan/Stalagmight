# fn-15-ygz.4 Add system-level selection and hover highlighting

## Description

Add system-level selection and hover highlighting.

**Size:** M
**Files:**
- `src/components/GlobalView/GlobalSurveyLayer.ts` (selection/hover)
- `src/components/GlobalView/GlobalViewMap.tsx` (event wiring)
- `src/store/globalViewStore.ts` (selection state)

## Approach

- Use filter-based highlighting (not setFeatureState)
- Add highlight layer with filter `['==', ['get', 'systemId'], selectedSystemId]`
- Selection style: thicker strokes (1.5x configurable), scaled stations
- Multi-select with Ctrl+click
- Double-click opens project
- Tooltip follows cursor, shows name + totalLength + stationCount
- Per memory: only fire hover(false) if no other feature type is hovered
- Per memory: use opaque colors with tiny opacity for hitbox layers
- Top system wins for overlapping clicks

## Acceptance

- [ ] Clicking shot/station selects entire system
- [ ] Ctrl+click adds/removes from selection
- [ ] Hovering highlights entire system with thicker strokes
- [ ] Double-click opens project
- [ ] Tooltip shows system name and stats from feature properties
- [ ] Filter-based highlighting (not feature-state)

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
