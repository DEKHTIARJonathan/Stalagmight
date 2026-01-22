# fn-15-ygz.2 Create GlobalSurveyLayer for multi-system rendering

## Description
Create `GlobalSurveyLayer` class for read-only multi-system rendering on the global map.

**Size:** M
**Files:** 
- `src/components/GlobalView/GlobalSurveyLayer.ts` (new file)
- `src/components/GlobalView/GlobalViewMap.tsx` (integrate layer)

## Approach

- Follow MapLibre layer patterns from `SurveyLayer.tsx:276-596`
- Use GeoJSON source with `tolerance: 0.5` for simplification
- Single source with all systems, `match` expression for per-system colors
- Feature properties: systemId, name, totalLength, stationCount
- Use filter-based highlighting (not setFeatureState)
- Assign colors via HSL hue rotation based on deterministic hash of file_path
## Approach

- Follow MapLibre layer patterns from `SurveyLayer.tsx:276-596`
- Use GeoJSON source with `tolerance: 0.5` for built-in simplification
- Single source with all systems, use `match` expression for per-system colors
- **Feature properties**: Each feature includes `systemId` (file_path), `name`, `totalLength`, `stationCount`
- Avoid `setFeatureState` - use filter-based highlighting instead (per research findings)
- Assign colors via HSL hue rotation based on deterministic hash of file_path

## Key context

- Use `generateId: true` on GeoJSON source for feature identification
- Per memory pitfall: use opaque colors with tiny opacity (0.001) not rgba(0,0,0,0) for hitbox layers
- Layer ordering: shots below stations
- Feature properties enable: search filtering, tooltip content, system identification
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
- [ ] GlobalSurveyLayer renders shots as lines, stations as circles
- [ ] Each system has distinct, stable color
- [ ] GeoJSON source uses tolerance: 0.5
- [ ] Features include properties for filtering/tooltips
- [ ] Virtual shots can be filtered via layer filter
- [ ] Layer integrates with GlobalViewMap
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
