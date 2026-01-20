# fn-5-jef.3 Implement depth-based coloring in SurveyLayer.update()

## Description
Implement depth-based coloring logic in `SurveyLayer.update()`.

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
- [ ] Stations colored by depth when `showDepthGradient` enabled
- [ ] Shots colored by average depth of endpoints when enabled
- [ ] Station labels colored by depth when enabled  
- [ ] Shot data labels colored by depth when enabled
- [ ] Virtual shots use depth coloring (same code path)
- [ ] Loop closures keep error-severity colors unchanged
- [ ] Merges keep distinct styling unchanged
- [ ] NaN depth values fall back to section color
- [ ] `getDepthColor` imported from `@/utils/colors`
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
