# fn-5-jef.4 Handle zero datum stations with gold border + depth fill

## Description
Handle zero datum stations with gold stroke and depth-colored fill when depth gradient is enabled.

## Current Behavior (L256-270)
Zero datum stations have:
- Larger radius (8 vs 4)
- Gold fill color (#ffd700)
- Black stroke

## New Behavior with Depth Gradient
When `showDepthGradient` enabled:
- Keep larger radius (8)
- **Fill**: depth-based color (from getDepthColor)
- **Stroke**: gold (#ffd700) for zero datum, black for others
- Stroke width: 2 for zero datum (increased visibility)

## Files to Modify

### `src/components/Map/SurveyLayer.tsx`

#### In `initializeLayers()` (L249-271)
Update stations layer paint to support dynamic stroke color:
```typescript
paint: {
  'circle-radius': ['case', ['get', 'isZeroDatum'], 8, 4],
  'circle-color': ['get', 'color'],
  'circle-stroke-width': ['case', ['get', 'isZeroDatum'], 2, 1],
  'circle-stroke-color': ['get', 'strokeColor'],  // Dynamic per-feature
}
```

#### In `update()` station feature building
Add `strokeColor` property:
```typescript
const isZeroDatum = station.is_zero_datum ?? false;
const strokeColor = showDepthGradient && isZeroDatum ? '#ffd700' : '#000000';

// Station feature properties:
{
  ...existingProps,
  color,  // depth color or section color
  strokeColor,  // gold for zero datum in depth mode, else black
}
```

#### In `updateVisualState()` - CRITICAL FIX
**Current behavior**: Always overrides `circle-stroke-color` with hardcoded colors, falling back to `#000000`.

**Fix**: Use `['get','strokeColor']` as fallback instead of hardcoded black:
```typescript
// In updateVisualState(), stroke color fallback:
// Before: '#000000'
// After: ['get', 'strokeColor']
this.map.setPaintProperty(
  this.stationsLayerId,
  'circle-stroke-color',
  ['case',
    snappedCondition, '#00ffcc',  // Snapped highlight
    hoveredCondition, '#ffcc00',  // Hovered highlight
    selectedCondition, '#ff6600', // Selected highlight
    ['get', 'strokeColor']  // Default from feature (gold for zero datum, black otherwise)
  ]
);
```

## Visual Result
- **Normal mode**: Zero datum = gold fill, black stroke
- **Depth mode**: Zero datum = depth fill, gold stroke (stands out as entry point)
- **Hovered/Selected**: Override stroke colors still work
## Current Behavior (L256-270)
Zero datum stations have:
- Larger radius (8 vs 4)
- Gold fill color (#ffd700)
- Black stroke

## New Behavior with Depth Gradient
When `showDepthGradient` enabled:
- Keep larger radius (8)
- **Fill**: depth-based color (from getDepthColor)
- **Stroke**: gold (#ffd700) for zero datum, black for others
- Stroke width: 2 for zero datum (increased visibility)

## Files to Modify

### `src/components/Map/SurveyLayer.tsx`

#### In `initializeLayers()` (L249-271)
Update stations layer paint to support dynamic stroke color:
```typescript
paint: {
  'circle-radius': ['case', ['get', 'isZeroDatum'], 8, 4],
  'circle-color': ['get', 'color'],  // Already uses feature property
  'circle-stroke-width': ['case', ['get', 'isZeroDatum'], 2, 1],
  'circle-stroke-color': ['get', 'strokeColor'],  // NEW: dynamic stroke
}
```

#### In `update()` station feature building
Add `strokeColor` property:
```typescript
const isZeroDatum = station.is_zero_datum ?? false;
const strokeColor = showDepthGradient && isZeroDatum ? '#ffd700' : '#000000';

// Station feature properties:
{
  ...existingProps,
  color,  // depth color or section color
  strokeColor,  // gold for zero datum in depth mode, else black
}
```

#### In `updateVisualState()` 
Ensure highlight/selection colors still override stroke when applicable.

## Visual Result
- **Normal mode**: Zero datum = gold fill, black stroke
- **Depth mode**: Zero datum = depth fill, gold stroke (stands out as entry point)
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
- [ ] Zero datum stations have gold stroke when depth gradient enabled
- [ ] Zero datum stations have depth-colored fill when enabled
- [ ] Normal stations keep black stroke in all modes
- [ ] Stroke width increased to 2 for zero datum visibility
- [ ] `strokeColor` property added to station features
- [ ] MapLibre paint uses `['get', 'strokeColor']` 
- [ ] `updateVisualState()` fallback uses `['get', 'strokeColor']` not hardcoded black
- [ ] Selection/hover highlights still work (only override when snapped/hovered/selected)
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
