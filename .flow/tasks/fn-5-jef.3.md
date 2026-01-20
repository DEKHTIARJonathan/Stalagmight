# fn-5-jef.3 Implement depth-based coloring in SurveyLayer.update()

## Description
Implement depth-based coloring in `SurveyLayer.update()` for stations, shots, and ALL labels.

## File: `src/components/Map/SurveyLayer.tsx`

### Station Feature Building (L770-790)
Use null-coalescing for fallback:
```typescript
const stationDepth = station.coordinates.z;
const depthColor = showDepthGradient 
  ? getDepthColor(stationDepth, '#00bfff', '#ff4444', depthRange.min, depthRange.max)
  : null;
const color = depthColor ?? (section?.color ?? '#ffffff');
```

### Shot Feature Building (L723-740)
Same pattern:
```typescript
const fromDepth = fromStation.coordinates.z;
const toDepth = toStation.coordinates.z;
const avgDepth = (fromDepth + toDepth) / 2;
const depthColor = showDepthGradient
  ? getDepthColor(avgDepth, '#00bfff', '#ff4444', depthRange.min, depthRange.max)
  : null;
const color = depthColor ?? section.color;
```

### Station Labels (initializeLayers + update)
**In initializeLayers() L372 - Change paint:**
```typescript
paint: {
  'text-color': ['get', 'color'],  // Was hardcoded '#ffffff'
  'text-halo-color': '#000000',
  'text-halo-width': 2,  // Increase from 1.5 for depth color readability
  ...
}
```

**In update() - Add color to station label features:**
```typescript
const labelDepthColor = showDepthGradient
  ? getDepthColor(station.coordinates.z, '#00bfff', '#ff4444', depthRange.min, depthRange.max)
  : null;
const labelColor = labelDepthColor ?? '#ffffff';

// Station label feature properties:
color: labelColor,
```

### Shot Data Labels - ALSO NEEDS UPDATE
**In initializeLayers() - Shot labels paint (survey-shot-labels):**
```typescript
paint: {
  'text-color': ['get', 'color'],  // Was hardcoded '#ffffff'
  'text-halo-color': '#000000',
  'text-halo-width': 2,
  ...
}
```

**In update() - Add color to shot label features:**
```typescript
const shotLabelDepthColor = showDepthGradient
  ? getDepthColor(avgDepth, '#00bfff', '#ff4444', depthRange.min, depthRange.max)
  : null;
const shotLabelColor = shotLabelDepthColor ?? '#ffffff';

// Shot label feature properties:
color: shotLabelColor,
```

### Imports
Add at top of file:
```typescript
import { getDepthColor } from '@/utils/colors';
```

### Unchanged Elements
- Loop closures (L223-235): Keep error-severity coloring - separate source
- Merges (L193-221): Keep distinct styling
- Ghost previews: Keep ghost styling
## File: `src/components/Map/SurveyLayer.tsx`

### Station Feature Building (L770-790)
```typescript
const stationDepth = station.coordinates.z;
const depthColor = showDepthGradient 
  ? getDepthColor(stationDepth, '#00bfff', '#ff4444', depthRange.min, depthRange.max)
  : null;
const color = depthColor ?? (section?.color ?? '#ffffff');
```

### Shot Feature Building (L723-740)
```typescript
const fromDepth = fromStation.coordinates.z;
const toDepth = toStation.coordinates.z;
const avgDepth = (fromDepth + toDepth) / 2;
const depthColor = showDepthGradient
  ? getDepthColor(avgDepth, '#00bfff', '#ff4444', depthRange.min, depthRange.max)
  : null;
const color = depthColor ?? section.color;
```

### Station Labels (initializeLayers + update)
**In initializeLayers() L372 - Change paint:**
```typescript
paint: {
  'text-color': ['get', 'color'],  // Was hardcoded '#ffffff'
  'text-halo-color': '#000000',
  'text-halo-width': 2,  // Increase from 1.5 for depth color readability
  ...
}
```

**In update() - Add color to station label features:**
```typescript
// Station label feature properties
color: showDepthGradient ? (depthColor ?? '#ffffff') : '#ffffff',
```

### Shot Data Labels
Same pattern as station labels - add `color` property and use `['get', 'color']` in paint.

### Imports
Add at top of file:
```typescript
import { getDepthColor } from '@/utils/colors';
```

### Unchanged Elements
- Loop closures (L223-235): Keep error-severity coloring - separate source
- Merges (L193-221): Keep distinct styling
- Ghost previews: Keep ghost styling
## File: `src/components/Map/SurveyLayer.tsx`

### Station Feature Building (L770-790)
Current code at ~L772-773:
```typescript
color: section?.color ?? '#ffffff',
```
Change to:
```typescript
const stationDepth = station.coordinates.z;
const color = this.showDepthGradient && isFinite(stationDepth)
  ? getDepthColor(stationDepth, '#00bfff', '#ff4444', this.depthRange.min, this.depthRange.max)
  : section?.color ?? '#ffffff';
```

### Shot Feature Building (L723-740)
Current code at ~L735:
```typescript
color: section.color,
```
Change to:
```typescript
const fromDepth = fromStation.coordinates.z;
const toDepth = toStation.coordinates.z;
const avgDepth = (fromDepth + toDepth) / 2;
const color = this.showDepthGradient && isFinite(avgDepth)
  ? getDepthColor(avgDepth, '#00bfff', '#ff4444', this.depthRange.min, this.depthRange.max)
  : section.color;
```

### Station Labels (~L800-820)
Apply same depth color to station index labels when enabled.

### Shot Data Labels
Apply same depth color to shot azimuth/length/depth labels when enabled.

### Unchanged Elements
- Loop closures (L223-235): Keep error-severity coloring
- Merges (L193-221): Keep distinct styling
- Ghost previews: Keep ghost styling

## Imports
Add at top of file:
```typescript
import { getDepthColor } from '@/utils/colors';
```

## Performance Note
Use existing loop structure - avoid creating large arrays for Math.min/max (memory overflow risk on large projects).
## Files to Modify

### `src/components/Map/SurveyLayer.tsx`
Modify `update()` method (L704-980) to conditionally use depth colors.

## Implementation

### 1. Get depth range from project stats
```typescript
// In update(), get min/max depth from project
const minDepth = this.project?.stats?.min_depth ?? 0;
const maxDepth = this.project?.stats?.max_depth ?? 50;
```

### 2. Modify station feature building (L770-790)
```typescript
// Current: color: section?.color ?? '#ffffff'
// New:
const color = this.showDepthGradient
  ? getDepthColor(station.coordinates.z, '#00bfff', '#ff4444', minDepth, maxDepth)
  : section?.color ?? '#ffffff';
```

### 3. Modify shot feature building (L732-740)
```typescript
// Current: color: section.color
// New:
const avgDepth = (fromStation.coordinates.z + toStation.coordinates.z) / 2;
const color = this.showDepthGradient
  ? getDepthColor(avgDepth, '#00bfff', '#ff4444', minDepth, maxDepth)
  : section.color;
```

### 4. Modify station labels (around L800-820)
Apply depth color to station index labels when enabled.

### 5. Modify shot data labels
Apply depth color to shot azimuth/length/depth labels when enabled.

### 6. Keep excluded elements unchanged
- Loop closures (keep error-severity colors)
- Merges (keep distinct styling)
- Ghost previews (keep ghost styling)

## Notes
- Import `getDepthColor` from `@/utils/colors`
- Virtual shots use same depth coloring as regular shots
- z=0 is treated as surface level (shallowest color)
## Acceptance
- [ ] Stations use `depthColor ?? sectionColor` pattern (not direct assignment)
- [ ] Shots use `depthColor ?? sectionColor` pattern
- [ ] Station labels layer paint uses `['get', 'color']`
- [ ] Station label features have `color` property with null fallback
- [ ] Shot labels layer paint uses `['get', 'color']`
- [ ] Shot label features have `color` property with null fallback
- [ ] Text halo width increased to 2 for readability
- [ ] Virtual shots use depth coloring (same code path)
- [ ] Loop closures and merges unchanged
- [ ] `getDepthColor` imported from `@/utils/colors`
- [ ] `pnpm tsc --noEmit` passes
## Done summary
Added depth-based coloring to station and shot labels in SurveyLayer. Updated label layer paints to use dynamic ['get', 'color'] instead of hardcoded white, increased text halo width to 2 for readability, and added color properties to label features with proper white (#ffffff) fallback when depth gradient is disabled or depth is invalid.
## Evidence
- Commits: 8d60d7c, 1f43655
- Tests: pnpm tsc --noEmit
- PRs: