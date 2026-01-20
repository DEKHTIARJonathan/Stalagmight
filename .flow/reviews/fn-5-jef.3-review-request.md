# Implementation Review Request: fn-5-jef.3

## Task
Implement depth-based coloring in SurveyLayer.update() for stations, shots, and ALL labels.

## Acceptance Criteria
- Stations use `depthColor ?? sectionColor` pattern (not direct assignment)
- Shots use `depthColor ?? sectionColor` pattern
- Station labels layer paint uses `['get', 'color']`
- Station label features have `color` property with null fallback
- Shot labels layer paint uses `['get', 'color']`
- Shot label features have `color` property with null fallback
- Text halo width increased to 2 for readability
- Virtual shots use depth coloring (same code path)
- Loop closures and merges unchanged
- `getDepthColor` imported from `@/utils/colors`
- `pnpm tsc --noEmit` passes

## Changes Made (diff from fee4059..HEAD)

### src/components/Map/SurveyLayer.tsx

**Shot labels layer paint (initializeLayers):**
- Changed `'text-color': '#ffffff'` to `'text-color': ['get', 'color']`
- Changed `'text-halo-width': 1.5` to `'text-halo-width': 2`

**Station labels layer paint (initializeLayers):**
- Changed `'text-color': '#ffffff'` to `'text-color': ['get', 'color']`
- Changed `'text-halo-width': 1.5` to `'text-halo-width': 2`

**Shot label features (update method):**
- Added `shotLabelColor = shotColor` (reuses the shot's depth/section color)
- Added `color: shotLabelColor` to feature properties

**Station label features (update method):**
- Added depth color calculation: `stationLabelDepthColor = this.showDepthGradient ? getDepthColor(...) : null`
- Added `stationLabelColor = stationLabelDepthColor ?? '#ffffff'` with proper null fallback
- Added `color: stationLabelColor` to feature properties

## Notes
- Station/shot features already had depth coloring from previous task (fn-5-jef.1)
- Loop closures and merges are untouched (use separate error-severity colors)
- Ghost previews are untouched (keep ghost styling)
- Type check passes: `pnpm tsc --noEmit`

## Review Questions
1. Does the implementation satisfy all acceptance criteria?
2. Is the null-coalescing pattern used correctly for fallback colors?
3. Are there any edge cases not handled?
