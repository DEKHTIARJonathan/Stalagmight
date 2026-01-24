# fn-15-ygz.3 Implement lazy loading with marker placeholders

## Description

Implement lazy loading of survey geometry with marker placeholders.

**Size:** M
**Files:**
- `src/components/GlobalView/GlobalViewMap.tsx` (loading state, GPS filter fix)
- `src/components/GlobalView/GlobalView.tsx` (data fetching, GPS filter fix)
- `src/store/globalViewStore.ts` (state management)

## Approach

- Track loading state per system: idle | loading | loaded | error
- **GPS filter fix**: Replace sentinel checks `gps_center[0] !== 0 && gps_center[1] !== 0` with simple null check `gps_center !== null` at:
  - `GlobalView.tsx:107` - gpsProjects filter
  - `GlobalView.tsx:239` - Map tab count
  - `GlobalViewMap.tsx:29` - gpsProjects filter
- Use `map.getBounds()` to determine which systems to load
- Prioritize visible systems by distance from viewport center
- Show spinner on marker while loading
- Fade transition (150ms) when geometry appears
- Keep geometry in memory until user enters single-system view
- Cancel pending loads when user opens a project (avoid race conditions)

## Acceptance

- [x] GPS filter uses `gps_center !== null` only (no sentinel check)
- [x] Systems show markers with spinner while loading
- [x] Geometry loads on demand when visible in viewport
- [x] Loading state tracked per system (idle/loading/loaded/error)
- [ ] Fade transition (150ms) when survey data appears (survey layer already animates, no additional CSS needed)
- [x] Failed loads show red marker
- [x] Geometry cached until single-system view

## Done summary
Implemented lazy loading of survey geometry for GlobalView map with marker loading states.

### Changes

**Backend:**
- Added `get_survey_geometry_for_file` async command to load geometry from arbitrary project files
- Refactored to share `get_survey_geometry_for_project` implementation between both commands

**Frontend:**
- Created `globalViewStore.ts` for per-system geometry loading states (idle/loading/loaded/error)
- Fixed GPS filter to use `gps_center !== null` only (removed sentinel check)
- Added lazy loading on map moveend, prioritized by distance from viewport center
- Markers show spinner while loading, red color on error
- Geometry cached until entering single-system view

### Files Modified
- src-tauri/src/commands/survey_geometry.rs
- src-tauri/src/lib.rs
- src/store/globalViewStore.ts (new)
- src/components/GlobalView/GlobalView.tsx
- src/components/GlobalView/GlobalViewMap.tsx
- src/index.css
## Evidence
- Commits:
- Tests: rust, typescript, ui
- PRs: