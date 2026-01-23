# fn-15-ygz.4 Add system-level selection and hover highlighting

<!-- Updated by plan-sync: fn-15-ygz.2 already implemented base selection/hover in GlobalSurveyLayer -->

## Description

Extend existing selection and hover highlighting with multi-select and tooltip features.

**Size:** M
**Files:**
- `src/components/GlobalView/GlobalSurveyLayer.ts` (multi-select, tooltip)
- `src/components/GlobalView/GlobalViewMap.tsx` (event wiring for multi-select, double-click)
- `src/store/globalViewStore.ts` (selection state for multi-select)

## Approach

**Already implemented in fn-15-ygz.2:**
- Single selection via `setSelectedSystem(filePath: string | null)` method
- Hover highlighting via `onSystemHover` callback and `updateVisualState()`
- Click detection via `onSystemClick` callback with hitbox layers (0.001 opacity)
- Filter-based highlighting using paint property expressions (not setFeatureState)
- Thicker strokes (4px hovered, 3px selected, 2px default) and larger stations (6px hovered, 5px selected, 4px default)

**Remaining work:**
- Multi-select with Ctrl+click (add `selectedSystemIds: Set<string>` state)
- Double-click opens project (wire `onProjectOpen` to dblclick)
- Tooltip follows cursor, shows name + totalLength + stationCount from feature properties
- Update `updateVisualState()` to handle multiple selected IDs
- Per memory: only fire hover(false) if no other feature type is hovered
- Top system wins for overlapping clicks (already implemented - stations checked before shots)

## Acceptance

- [ ] Clicking shot/station selects entire system (already works via onSystemClick)
- [ ] Ctrl+click adds/removes from selection
- [ ] Hovering highlights entire system with thicker strokes (already works)
- [ ] Double-click opens project
- [ ] Tooltip shows system name and stats from feature properties
- [ ] Filter-based highlighting (not feature-state) (already implemented)

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
