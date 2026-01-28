# CaveChef Architecture

> For full data model, UI design, and workflows, see [SPEC.md](SPEC.md).

## State Flow

```
User Action → Zustand Store → Tauri IPC → Rust Command Executor
     ↑                                              │
     └──────────── State Update ←──────── Command Result
```

## Command Pattern

All persistent operations go through the Rust `Command` enum in `src-tauri/src/core/command.rs`. The `AppState` in `state.rs` executes commands and manages undo/redo.

## Data Model

- **Project**: Contains sections, station merges, zero datums, section offsets
- **Section**: Group of shots with metadata (name, surveyor, date, color)
- **Shot**: Single measurement (azimuth, length, depth, LRUD)
- **Station**: Computed from shots, can be merged or set as zero datum

## Key Files

| File | Purpose |
|------|---------|
| `src-tauri/src/core/command.rs` | Command enum and result types |
| `src-tauri/src/core/state.rs` | AppState with command execution, auto-save |
| `src-tauri/src/persistence/sqlite.rs` | Database schema and operations |
| `src-tauri/src/parsers/dmp.rs` | mNemo DMP file parser |
| `src-tauri/src/models/project.rs` | Project model with merge/offset logic |
| `src-tauri/src/models/geo.rs` | GPS-to-local coordinate transformation (WGS84 → ENU) |
| `src-tauri/src/cache/tiles.rs` | Satellite tile cache (SQLite-based) |
| `src-tauri/src/commands/cache.rs` | Cache IPC commands (stats, clear, fetch) |
| `src-tauri/src/commands/survey.rs` | Survey geometry IPC command (`get_survey_geometry_for_file`) |
| `src/store/projectStore.ts` | Frontend state, Tauri IPC calls |
| `src/store/uiStore.ts` | UI state (selection, tools, panels) |
| `src/store/globalViewStore.ts` | Global View state (selection, geometry loading) |
| `src/components/Map/MapCanvas.tsx` | MapLibre map initialization |
| `src/components/Map/SurveyLayer.tsx` | Survey rendering on map |
| `src/components/GlobalView/GlobalView.tsx` | Global View container component |
| `src/components/GlobalView/GlobalViewMap.tsx` | MapLibre map for Global View |
| `src/components/GlobalView/GlobalSurveyLayer.ts` | Multi-system survey geometry rendering |
| `src/components/GlobalView/ViewModeToggle.tsx` | View mode toggle and `useViewMode` hook |
| `src/components/GlobalView/MetadataPanel.tsx` | System metadata display with aggregate stats |
| `src/utils/coordinates.ts` | Coordinate transforms (meters ↔ GPS) |
| `src/utils/tileProtocol.ts` | MapLibre tile protocol for caching |
| `src/hooks/useProject.ts` | Project file operations hook |
| `src/hooks/useMapTools.ts` | Map tool handlers |
| `src/hooks/useKeyboardShortcuts.ts` | Global keyboard shortcut handler |
| `src/hooks/useFpsMonitor.ts` | FPS monitoring for auto-throttle |

## Rust Backend Patterns

### Mutex Lock Ordering

**Critical**: Never hold a Mutex lock while calling methods that acquire other locks. This caused a deadlock bug where auto-save held the `config` lock while calling `save_project`, which tried to lock `config` again.

**Pattern to avoid**:
```rust
// BAD - holds lock while calling other method
if let Ok(config) = self.config.lock() {
    if config.auto_save {
        self.save_project(None); // save_project also locks config!
    }
}

// GOOD - release lock before calling
let should_save = self.config.lock().map(|c| c.auto_save).unwrap_or(false);
if should_save {
    self.save_project(None);
}
```

### Safe File Save

Always use temp file + atomic rename pattern for saves:
1. Write to `file.cvproj.tmp`
2. On success, rename to `file.cvproj`
3. On failure, delete temp file

This prevents data loss if save fails mid-write.

### Section Offset Tracking

When stations are merged, section positions are recalculated:
1. Build graph of section connections through merges
2. Anchor section (first or with zero datum) stays fixed
3. Calculate offsets for connected sections
4. Store in `Project.section_offsets: HashMap<SectionId, (f64, f64)>`

### Database Operations

- Use `Database::open_existing()` for reading (doesn't create files)
- Use `Database::open()` for writing (creates if needed)
- Shot IDs are generated on load: `section_id * 100000 + sequence`

### Coordinate Transformation (Zero Datum)

When a station is set as zero datum with GPS coordinates, the system converts GPS (WGS84) to local ENU (East-North-Up) meters:

**Algorithm** (in `src-tauri/src/models/geo.rs`):
1. **Geodetic → ECEF**: Convert lat/lon to Earth-Centered Earth-Fixed coordinates using WGS84 ellipsoid
2. **ECEF → ENU**: Rotate ECEF difference to local tangent plane at origin
3. **Result**: (east, north) offset in meters relative to zero datum

**Key functions**:
- `geodetic_to_ecef(lat, lon, alt)` - WGS84 to ECEF (public)
- `ecef_to_enu(dx, dy, dz, lat0, lon0)` - ECEF diff to ENU (private)
- `gps_to_local(gps, origin)` - Main entry point returning (east, north)

**Important notes**:
- Altitude is always 0; `depth_reference` is meters below surface, not ellipsoid height
- The "Up" component is discarded; caves use depth measurements instead
- Section offsets are tracked in `Project.section_offsets` to maintain visual positions after datum changes

## Global View Data Flow

The Global View renders survey geometry for multiple GPS-positioned systems:

```
User loads Global View
    │
    ▼
GlobalView.tsx (container)
    ├── Fetches ProjectMetadata[] via get_recent_projects
    ├── Filters to GPS-positioned systems
    └── Renders GlobalViewMap
            │
            ▼
GlobalViewMap.tsx
    ├── Initializes MapLibre with Esri World Imagery via cavechef-tiles:// protocol
    ├── Restores persisted map position from localStorage
    ├── Creates GlobalSurveyLayer for geometry rendering
    └── On map moveend → loadGeometryBatch(visible systems)
            │
            ▼
globalViewStore.ts (Zustand)
    ├── loadGeometryBatch() sequences geometry fetches
    ├── Calls get_survey_geometry_for_file IPC for each system
    ├── Tracks loading/loaded/error state per system
    └── Stores SurveyGeometry in Map<filePath, geometry>
            │
            ▼
GlobalSurveyLayer.ts
    ├── Receives geometry updates via update()
    ├── Creates GeoJSON sources/layers for shots and stations
    ├── Applies search filter via setSearchFilter()
    └── Updates selection highlighting via setSelectedSystems()
```

### View Mode Toggle

The `useViewMode` hook persists view mode (`survey` | `markers`) to localStorage:

```typescript
const [viewMode, setViewMode] = useViewMode();
// - 'survey': shows geometry; markers hidden when geometry loaded,
//   visible with spinner during loading, visible (red) on error
// - 'markers': shows all markers (no geometry), all interactions preserved
```

Marker visibility is controlled by three effects:
1. **Creation effect** - sets initial `el.style.display` based on `viewModeRef.current` and geometry state
2. **Styles effect** - updates marker colors (selection, error) without recreating markers
3. **Visibility-sync effect** - toggles `el.style.display` (`'none'` / `'flex'`) on `viewMode` and `geometryStates` changes

Switching to markers mode cancels pending geometry loads to save resources.

### FPS Monitoring

The `useFpsMonitor` hook tracks frame rate using `requestAnimationFrame`:

```typescript
const { isThrottled } = useFpsMonitor(
  onThrottleNeeded,  // Called when FPS drops below threshold
  onThrottleRestore, // Called when FPS recovers
  { fpsThreshold: 30, recoveryThreshold: 45, enabled: true }
);
```

When throttled, `GlobalSurveyLayer.setTolerance()` increases GeoJSON simplification.
