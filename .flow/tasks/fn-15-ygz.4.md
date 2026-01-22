# fn-15-ygz.4 Add system-level selection and hover highlighting

## Description
Add system-level selection and hover highlighting. Clicking any shot/station selects the entire system. Hovering highlights all shots/stations in that system.

**Size:** M
**Files:** 
- `src/components/GlobalView/GlobalSurveyLayer.ts` (selection/hover handling)
- `src/components/GlobalView/GlobalViewMap.tsx` (event wiring)
- `src/store/globalViewStore.ts` (selection state)

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
- [ ] Clicking shot/station selects entire system (visual highlight)
- [ ] Ctrl+click adds/removes system from selection
- [ ] Hovering highlights entire system with thicker strokes
- [ ] Double-click opens the project
- [ ] Tooltip shows system name, total length, station count
- [ ] Selection/hover uses filter-based highlighting (not feature-state)
- [ ] Overlapping systems: top system wins clicks
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
