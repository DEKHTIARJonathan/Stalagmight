# Global View Survey Rendering

## Overview

Transform the global view from showing markers to rendering actual survey geometry (shots and stations) for all GPS-positioned projects.

## Scope

**In scope:** Survey geometry rendering, system-level selection, lazy loading, auto-throttle, search/filter, keyboard navigation, view mode toggle, soft bounds

**Out of scope:** Individual shot/station selection, editing, loop closures, station name labels

## Approach

### Backend Changes

1. **Fix coordinate order**: Standardize on `[lng, lat]` for MapLibre compatibility. Update `gps_center` in Rust to store `(longitude, latitude)` instead of current `(latitude, longitude)`.

2. **Extend ProjectMetadata** to include `station_count`

3. New Tauri command `get_survey_geometry` (async to avoid UI blocking):
   ```rust
   #[derive(Serialize)]
   struct Shot {
     from: [f64; 2],  // [lng, lat]
     to: [f64; 2],    // [lng, lat]
     is_virtual: bool,
   }
   
   #[derive(Serialize)]
   struct SurveyGeometry {
     file_path: String,
     name: String,
     total_length: f64,
     station_count: usize,
     gps_origin: [f64; 2],  // [lng, lat] - the zero datum GPS position
     shots: Vec<Shot>,
     stations: Vec<[f64; 2]>,  // [lng, lat] positions
   }
   ```

4. **GPS coordinate transformation (Rust)** - compute relative to zero-datum station:
   ```rust
   // 1. Find zero-datum station and its raw coords (x0, y0)
   // 2. For each station at (x, y): compute delta dx = x - x0, dy = y - y0
   // 3. Transform: 
   //    lng = origin_lng + (dx / meters_per_degree_lng)
   //    lat = origin_lat + (dy / meters_per_degree_lat)
   //    where meters_per_degree_lng = 111320.0 * cos(origin_lat_rad)
   ```

5. **Register command** in `src-tauri/src/lib.rs` `generate_handler![]` list

6. **Add config options** to Rust config for fps_threshold, tolerance, throttle_tolerance

7. **GPS filter**: Only process projects where `gps_center != null` (not `(0,0)` sentinel)

### Frontend Changes

**GPS filter cleanup** - Remove sentinel checks throughout the frontend:
- `GlobalView.tsx:107` - gpsProjects filter: remove `gps_center[0] !== 0 && gps_center[1] !== 0`
- `GlobalView.tsx:239` - Map tab count: same fix
- `GlobalViewMap.tsx:29` - gpsProjects filter: same fix
- `MetadataPanel.tsx:88` - formatGps guard: remove `(center[0] === 0 && center[1] === 0)`

1. Create `GlobalSurveyLayer` class for read-only multi-system rendering
2. GeoJSON sources with `tolerance: 0.5`, feature properties for filtering/tooltips
3. Filter-based highlighting (not setFeatureState)
4. FPS monitoring with `requestAnimationFrame`
5. Search filter using `index-of` + `downcase` expression
6. **Soft bounds**: Use `maxBounds` for hard limits + custom move listener with `easeTo` for rubber-band effect (MapLibre doesn't expose `transformConstrain`)
7. Context menu, error popups, position persistence

### Test Vectors

Create `tests/fixtures/coordinate_transform_vectors.json` with input/output pairs generated from frontend `metersToMapCoords`. Test same vectors in both Rust and TS.

## Quick commands
```bash
./scripts/dev.sh
pnpm tsc --noEmit
pnpm test:ui
cargo test --manifest-path src-tauri/Cargo.toml
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `global_view.fps_threshold` | 30 | FPS below which auto-throttle activates |
| `global_view.tolerance` | 0.5 | MapLibre GeoJSON simplification tolerance |
| `global_view.throttle_tolerance` | 1.0 | Higher tolerance when throttled |

## Acceptance

- [ ] Global view renders shots and stations for GPS-positioned projects
- [ ] Each system has distinct auto-assigned color (stable across sessions)
- [ ] System-level selection and hover with tooltip
- [ ] Multi-select with Ctrl+click, double-click opens
- [ ] Context menu with correct options
- [ ] Search filter dims non-matching (25% opacity)
- [ ] Keyboard shortcuts work
- [ ] Lazy loading with markers and spinners, fade transition
- [ ] Error states: red marker with popup
- [ ] View mode toggle persisted
- [ ] Auto-throttle when FPS drops
- [ ] Soft bounds with rubber-band effect
- [ ] Map position/zoom persisted
- [ ] MetadataPanel shows aggregate stats
- [ ] Projects without GPS not shown
- [ ] **Coordinate order standardized to [lng, lat]**
- [ ] **Transform accounts for zero-datum station offset**
- [ ] **Test vectors verify Rust/TS transform parity**
- [ ] Documentation updated
