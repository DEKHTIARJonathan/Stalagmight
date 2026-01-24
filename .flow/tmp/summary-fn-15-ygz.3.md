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
