# fn-5-jef.3 Implement depth-based coloring in SurveyLayer.update()

## Description
Implement depth-based coloring logic in `SurveyLayer.update()`.

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
- [ ] Virtual shots use depth coloring
- [ ] Loop closures keep error-severity colors
- [ ] Merges keep distinct styling
- [ ] Ghost previews keep ghost styling
- [ ] z=0 gets shallowest color
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
