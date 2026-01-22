# fn-15-ygz.4 Add system-level selection and hover highlighting

## Description
Add system-level selection and hover highlighting.

**Size:** M
**Files:** 
- `src/components/GlobalView/GlobalSurveyLayer.ts` (selection/hover)
- `src/components/GlobalView/GlobalViewMap.tsx` (event wiring)
- `src/store/globalViewStore.ts` (selection state)

## Approach

- Use filter-based highlighting with systemId property
- Selection style: thicker strokes (1.5x), scaled stations
- Multi-select with Ctrl+click
- Double-click opens project
- Tooltip shows name, totalLength, stationCount from feature properties
## Approach

- Use filter-based highlighting (not `setFeatureState`) per best practices
- Add highlight layer with filter `['==', ['get', 'systemId'], selectedSystemId]`
- `systemId` is the file_path from feature properties
- Selection style: thicker strokes (1.5x configurable), scaled stations
- Multi-select with Ctrl+click
- Double-click opens project
- Tooltip follows cursor, shows name + totalLength + stationCount from feature properties

## Key context

- Per memory: only fire hover(false) if no other feature type is hovered
- Per memory: use opaque colors with tiny opacity for hitbox layers
- Top system wins for overlapping clicks (no cycle-through)
- Feature properties provide all tooltip data without extra lookup
## Approach

- Use filter-based highlighting (not `setFeatureState`) per best practices
- Add highlight layer with filter `['==', ['get', 'systemId'], selectedId]`
- Selection style: thicker strokes (1.5x configurable), scaled stations
- Multi-select with Ctrl+click
- Double-click opens project
- Tooltip follows cursor, shows name + length + station count

## Key context

- Per memory: only fire hover(false) if no other feature type is hovered
- Per memory: use opaque colors with tiny opacity for hitbox layers
- Top system wins for overlapping clicks (no cycle-through)
## Acceptance
- [ ] Clicking shot/station selects entire system
- [ ] Ctrl+click adds/removes from selection
- [ ] Hovering highlights entire system
- [ ] Double-click opens project
- [ ] Tooltip shows system name and stats
- [ ] Filter-based highlighting (not feature-state)
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
