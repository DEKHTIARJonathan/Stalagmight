# Stalagmight Architecture

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
| `src-tauri/src/core/state.rs` | AppState with command execution |
| `src-tauri/src/persistence/sqlite.rs` | Database schema and operations |
| `src-tauri/src/parsers/dmp.rs` | mNemo DMP file parser |
| `src-tauri/src/models/project.rs` | Project model with merge/offset logic |
| `src-tauri/src/models/geo.rs` | GPS-to-local coordinate transformation (WGS84 → ENU) |
| `src-tauri/src/cache/tiles.rs` | Satellite tile cache (SQLite-based) |
| `src-tauri/src/tile_providers.rs` | Tile provider registry (provider metadata, URL expansion) |
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
| `src/utils/tileConfig.ts` | Tile source config; platform-specific `stalagmight-tiles` URL form |
| `src/hooks/useProject.ts` | Project file operations hook |
| `src/hooks/useMapTools.ts` | Map tool handlers |
| `src/hooks/useKeyboardShortcuts.ts` | Global keyboard shortcut handler |
| `src/hooks/useFpsMonitor.ts` | FPS monitoring for auto-throttle |
| `src/theme/tokens.ts` | Color theme token definitions (9 themes) |
| `src/components/Map/GridOverlay.tsx` | Theme-aware coordinate grid overlay |
| `src/components/Dialogs/KeyboardShortcutsDialog.tsx` | Keyboard shortcuts overlay (`?` key) |
| `src/components/Dialogs/settings/AppearanceSettings.tsx` | Theme mode & color theme selection UI |
| `src/components/Dialogs/settings/ThemePreviewCard.tsx` | Mini app mockup preview cards for themes |
| `src-tauri/src/config/types.rs` | Config types incl. `AppearanceConfig`, `PlacementSuggestionConfig`, `ImportConfig` |

## Color Theme System

Stalagmight supports 9 color themes with independent day (light) and night (dark) palettes:

| Theme | Type | Description |
|-------|------|-------------|
| `dark` | Dark | Default dark blue/purple with teal accent |
| `light` | Light | Default warm beige/paper with teal accent |
| `cave` | Dark | Very dark, desaturated with gold accent |
| `dracula` | Dark | Dracula-inspired with purple accent |
| `one_dark` | Dark | Atom One Dark-inspired with blue accent |
| `solarized_light` | Light | Solarized light with blue accent |
| `catppuccin_latte` | Light | Catppuccin Latte (light) with blue accent |
| `nord` | Dark | Nord-inspired with cyan accent |
| `catppuccin_mocha` | Dark | Catppuccin Mocha (dark) with blue accent |

### Theme Architecture

```
AppearanceConfig (Rust)          UIStore (Zustand)           CSS
  theme: ThemeMode          →    resolvedTheme: ResolvedTheme  →  CSS custom properties
  day_color_theme: ColorTheme        ↑                              (--cc-* vars)
  night_color_theme: ColorTheme      │
                               OS prefers-color-scheme
                               (when theme = "auto")
```

- **Backend**: `AppearanceConfig` in `config/types.rs` stores `ThemeMode` (dark/light/auto) and separate `ColorTheme` values for day and night
- **Frontend**: `uiStore.resolvedTheme` resolves the active theme. When `theme = "auto"`, the OS preference selects day or night palette
- **Tokens**: `src/theme/tokens.ts` maps each theme name to a set of CSS custom properties (`--cc-*`) covering UI chrome, map visualization, and map controls
- **Preview**: `ThemePreviewCard` renders mini app mockups; `ColorThemeCircle` shows 3-segment color swatches for quick selection

## Keyboard Shortcuts Overlay

Pressing `?` opens the `KeyboardShortcutsDialog`, a filterable grid showing all shortcuts grouped by category (Tools, Edit, View, Panels, File) plus reserved shortcuts. Includes a "Customize" button linking to Settings > Shortcuts.

## Grid Overlay

`GridOverlay.tsx` renders a coordinate grid on the map that scales with survey data. Grid spacing auto-selects from `[1, 5, 10, 25, 50, 100]` meters based on zoom level. The grid subscribes to `resolvedTheme` for theme-aware colors via the `--cc-grid-default` CSS variable.

## Rust Backend Patterns

### Mutex Lock Ordering

**Critical**: Never hold a Mutex lock while calling methods that acquire other locks. Release the first lock before calling methods that may acquire others.

**Pattern to avoid**:
```rust
// BAD - holds lock while calling other method
if let Ok(config) = self.config.lock() {
    self.do_something(); // may try to lock config again → deadlock!
}

// GOOD - release lock before calling
let value = self.config.lock().map(|c| c.some_field).unwrap_or(default);
self.do_something_with(value);
```

### Safe File Save

Always use temp file + atomic rename pattern for saves:
1. Write to `file.stalx.tmp`
2. On success, rename to `file.stalx`
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
    ├── Initializes MapLibre with Esri World Imagery via stalagmight-tiles:// protocol
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

### Tile Protocol (cross-platform)

Map tiles route through the `stalagmight-tiles` custom protocol, served by the
Rust handler registered in `src-tauri/src/lib.rs` via
`register_asynchronous_uri_scheme_protocol` (SQLite caching + offline support).
The frontend builds the MapLibre source URL in `src/utils/tileConfig.ts`
(`getTileConfig`).

The URL form **differs by platform** — this is a required gotcha, not a
preference:

| Platform | Tile URL template |
|----------|-------------------|
| macOS / Linux (WRY) | `stalagmight-tiles://<provider>/{z}/{y}/{x}` (provider = host) |
| **Windows (WebView2)** | `http://stalagmight-tiles.localhost/<provider>/{z}/{y}/{x}` (provider in path) |
| Android | `stalagmight-tiles://<provider>/{z}/{y}/{x}` via MapLibre `addProtocol` (see `tileProtocol.ts`) |

**Why:** WebView2 cannot navigate a bare custom URI scheme, so it serves
Tauri-registered protocols only under `http://<scheme>.localhost/...`. Using the
bare `stalagmight-tiles://` scheme on Windows means requests never reach the Rust
handler and **tiles silently fail to load** (no error, just blank tiles) while
macOS/Linux work fine. The Rust `parse_tile_uri` accepts both host-based and
path-based forms, so only the frontend URL needs to branch on platform
(`navigator.userAgent.includes('Windows')`).

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
