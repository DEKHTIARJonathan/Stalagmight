# fn-15-ygz.2 Create GlobalSurveyLayer for multi-system rendering

## Description
Create a `GlobalSurveyLayer` class that renders survey geometry for multiple systems on the global map. This is a simplified, read-only version of `SurveyLayer` optimized for multi-system overview rendering.

**Size:** M
**Files:** 
- `src/components/GlobalView/GlobalSurveyLayer.ts` (new file)
- `src/components/GlobalView/GlobalViewMap.tsx` (integrate layer)

## Approach

- Follow MapLibre layer patterns from `SurveyLayer.tsx:276-596`
- Use GeoJSON source with `tolerance: 0.5` for built-in simplification
- Single source with all systems, use `match` expression for per-system colors
- Avoid `setFeatureState` - use filter-based highlighting instead (per research findings)
- Assign colors via HSL hue rotation based on deterministic hash of file_path

## Key context

- Use `generateId: true` on GeoJSON source for feature identification
- Per memory pitfall: use opaque colors with tiny opacity (0.001) not rgba(0,0,0,0) for hitbox layers
- Layer ordering: shots below stations
## Acceptance
- [ ] `GlobalSurveyLayer` class renders shots as lines and stations as circles
- [ ] Each system has distinct, stable color (same file_path = same color)
- [ ] GeoJSON source uses `tolerance: 0.5` for simplification
- [ ] Virtual shots can be filtered out via layer filter
- [ ] Layer integrates with GlobalViewMap and renders on map load
- [ ] No TypeScript errors
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
