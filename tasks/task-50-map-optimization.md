# Task 50: Map Rendering Optimization

## Overview
Optimize MapLibre rendering for large surveys with progressive level-of-detail, geometry simplification when zoomed out, and layer caching.

## Priority
Medium-High - Phase F (Performance)

## Risk Level
Medium-High

## Dependencies
- Existing SurveyLayer component

## Files to Modify
- `src/components/Map/SurveyLayer.tsx` - LOD implementation
- `src/components/Map/MapCanvas.tsx` - Performance settings
- `src/utils/geometry.ts` - Simplification algorithms

## Specifications

### Level of Detail (LOD)
Progressive detail based on zoom level:
| Zoom | Detail Level |
|------|--------------|
| < 10 | Simplified paths, no labels |
| 10-14 | Normal paths, section labels only |
| 14-17 | Full detail, all labels |
| > 17 | Maximum detail |

### Geometry Simplification
When zoomed out:
- Reduce vertex count using Douglas-Peucker
- Merge nearby stations
- Hide small features
- Simplify based on pixel density

### Performance Targets
- Minimum 30 FPS during pan/zoom
- Handle 10,000 stations
- Smooth transitions between LOD levels

### Layer Caching
- Cache rendered geometry per section
- Invalidate on:
  - Section edit
  - Merge/unmerge
  - Offset change
- Don't cache during active editing

### Progressive Loading
- Render visible sections first
- Load off-screen sections in background
- Priority based on distance from viewport

### MapLibre-Only Approach
- No deck.gl in v1
- Use MapLibre's native rendering
- Custom layers only if necessary

### Rendering Settings (User Configurable)
```typescript
interface RenderingSettings {
  enableLOD: boolean;
  enableSimplification: boolean;
  maxStationsVisible: number;
  lodTransitionZoom: number[];
}
```

### Measurement
- FPS counter available in dev mode
- Performance logging for slow frames
- Profiling hooks for optimization

## Acceptance Criteria
- [ ] LOD system working
- [ ] Geometry simplifies when zoomed out
- [ ] Minimum 30 FPS maintained
- [ ] Handles 10,000 stations
- [ ] Settings configurable
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Playwright Tests (Mocked IPC)
1. Test LOD level changes with zoom
2. Test simplified paths at low zoom
3. Test full detail at high zoom
4. Test labels appear/disappear with LOD
5. Test rendering settings configurable
6. Test enableLOD toggle works
7. Test enableSimplification toggle works

### WebdriverIO Tests (Full App)
1. Test 30 FPS maintained with 5000 stations
2. Test 30 FPS maintained with 10000 stations
3. Test smooth pan/zoom with large survey
4. Test LOD transitions are smooth (no pop-in)
5. Test memory usage bounded with large data
6. Test layer caching improves performance

## Edge Cases
- Very dense station clusters
- Extremely zoomed out
- Rapid zoom changes
- Memory pressure
