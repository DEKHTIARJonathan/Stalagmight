# fn-15-ygz.2 Create GlobalSurveyLayer for multi-system rendering

## Description

Create `GlobalSurveyLayer` class for read-only multi-system rendering on the global map.

**Size:** M
**Files:**
- `src/components/GlobalView/GlobalSurveyLayer.ts` (new file)
- `src/components/GlobalView/GlobalViewMap.tsx` (integrate layer)

## Approach

- Follow MapLibre layer patterns from `SurveyLayer.tsx:276-596`
- Use GeoJSON source with `tolerance: 0.5` and `generateId: true`
- Single source with all systems, `match` expression for per-system colors
- Feature properties: systemId (file_path), name, totalLength, stationCount
- Use filter-based highlighting (not setFeatureState)
- Assign colors via HSL hue rotation based on deterministic hash of file_path
- Per memory: use opaque colors with tiny opacity (0.001) for hitbox layers
- Layer ordering: shots below stations

## Acceptance

- [ ] GlobalSurveyLayer renders shots as lines, stations as circles
- [ ] Each system has distinct, stable color
- [ ] GeoJSON source uses tolerance: 0.5
- [ ] Features include properties: systemId, name, totalLength, stationCount
- [ ] Virtual shots can be filtered via layer filter
- [ ] Layer integrates with GlobalViewMap

## Done summary
Created GlobalSurveyLayer class for multi-system survey rendering on the global map. Uses single GeoJSON source with featureType property to distinguish shots and stations, match expressions for per-system colors based on file_path hash, and filter-based virtual shot toggling. Integrated into GlobalViewMap with props-based geometry data and pending buffer for race condition handling.
## Evidence
- Commits: 38c4a6e, b3c3a46, ed91f75, eaa9ad6
- Tests: pnpm tsc --noEmit, cargo test --manifest-path src-tauri/Cargo.toml
- PRs: