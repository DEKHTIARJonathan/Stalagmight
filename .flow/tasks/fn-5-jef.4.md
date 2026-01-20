# fn-5-jef.4 Handle zero datum stations with gold border + depth fill

## Description
Handle zero datum stations with gold border and depth-colored fill.

## Current Behavior
Zero datum stations (entry points) have:
- Larger radius (8 vs 4)
- Gold fill color (#ffd700)
- Black stroke

## New Behavior with Depth Gradient
When `showDepthGradient` enabled:
- Keep larger radius (8)
- Fill: depth-based color (from getDepthColor)
- Stroke: gold (#ffd700) instead of black
- Stroke width: increase to 2-3px for visibility

## Files to Modify

### `src/components/Map/SurveyLayer.tsx`

#### In `initializeLayers()` (L249-271)
Update stations layer paint to support dynamic stroke color:
```typescript
paint: {
  'circle-radius': ['case', ['get', 'isZeroDatum'], 8, 4],
  'circle-color': ['get', 'color'],  // Already dynamic
  'circle-stroke-width': ['case', ['get', 'isZeroDatum'], 2, 1],
  'circle-stroke-color': ['get', 'strokeColor'],  // New property
}
```

#### In `update()` station feature building
Add `strokeColor` property:
```typescript
const isZeroDatum = station.is_zero_datum ?? false;
const strokeColor = this.showDepthGradient && isZeroDatum ? '#ffd700' : '#000000';
// Feature properties:
strokeColor,
```

## Visual Result
- Normal stations: depth color fill, black border
- Zero datum stations: depth color fill, gold border (stands out as entry point)
## Acceptance
- [ ] Zero datum stations have gold stroke when depth gradient on
- [ ] Zero datum stations have depth-colored fill when depth gradient on
- [ ] Normal stations keep black stroke
- [ ] Stroke width increased for zero datum visibility
- [ ] `strokeColor` property added to station features
- [ ] MapLibre paint uses `['get', 'strokeColor']`
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
