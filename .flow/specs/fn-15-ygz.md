# Global View Survey Rendering

## Overview

Transform the global view from showing markers to rendering actual survey geometry (shots and stations) for all GPS-positioned projects. This provides better visualization of cave system layouts and their geographic relationships.

## Scope

**In scope:**
- Survey geometry rendering (shots as lines, stations as circles)
- System-level selection (click any shot/station → select entire system)
- Lazy loading with marker placeholders
- Auto-throttle for performance
- Search/filter in toolbar
- Keyboard navigation (arrow keys, Ctrl+A, Enter, Delete, Escape)
- View mode toggle (survey ↔ markers)
- Soft bounds with rubber-band pan limiting
- Context menu with system actions
- Error states with popup details
- Persisted map position/zoom

**Out of scope:**
- Individual shot/station selection in global view
- Editing operations in global view
- Loop closures and merge connection visualization
- Station name labels (only system name shown)

## Approach

### Backend Changes

1. **Extend ProjectMetadata** to include `station_count` (Rust model + TS type)

2. New Tauri command `get_survey_geometry` returns lightweight GPS-transformed data with metadata:
   ```rust
   struct SurveyGeometry {
     file_path: String,
     name: String,
     total_length: f64,
     station_count: usize,
     gps_origin: [f64; 2],  // [lng, lat]
     shots: Vec<ShotLine>,
     stations: Vec<[f64; 2]>,
     is_virtual: Vec<bool>,
   }
   ```

3. **GPS coordinate transformation (Rust)** - use latitude-adjusted formula matching frontend:
   ```rust
   fn meters_to_map_coords(x: f64, y: f64, origin: [f64; 2]) -> [f64; 2] {
     let origin_lng = origin[0];
     let origin_lat = origin[1];
     // Match frontend formula exactly
     let meters_per_degree_lat = 111320.0;
     let meters_per_degree_lng = 111320.0 * origin_lat.to_radians().cos();
     let lng = origin_lng + (x / meters_per_degree_lng);
     let lat = origin_lat + (y / meters_per_degree_lat);
     [lng, lat]
   }
   ```
   Add unit tests comparing against frontend `metersToMapCoords` with same inputs.

4. **Add config options** to Rust config (`src-tauri/src/config/`):
   - `global_view.fps_threshold` (default 30)
   - `global_view.tolerance` (default 0.5)
   - `global_view.throttle_tolerance` (default 1.0)

5. **GPS filter**: Only fetch geometry for projects where `gps_center != null`

### Frontend Changes

1. Create `GlobalSurveyLayer` class for read-only multi-system rendering
2. Use GeoJSON sources with `tolerance: 0.5` for MapLibre simplification
3. Feature properties: `systemId`, `name`, `totalLength`, `stationCount`
4. Use filter-based highlighting (not `setFeatureState`)
5. Implement FPS monitoring with `requestAnimationFrame` timing
6. Add search filter using `index-of` + `downcase` expression
7. Context menu: Open, Zoom to System, Remove from Recent, Show in Folder, Merge Selected
8. Error popup on red marker click showing error message
9. Persist map position/zoom in local storage, restore on return

### Key Patterns to Reuse
- `metersToMapCoords()` from `src/utils/coordinates.ts:16-31`
- Expression building from `src/utils/maplibre-expressions.ts`
- Layer styling patterns from `SurveyLayer.tsx:276-596`
- Color palette from `src/utils/colors.ts:246-255`
- Context menu pattern from `GlobalView.tsx`

### Memory Pitfalls (from .flow/memory)
- Use opaque colors with tiny opacity for hitbox layers
- Disable MapLibre's built-in keyboard handler
- Only fire hover(false) if no other feature type is hovered
- Use refs for values in keydown handlers

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Performance | Auto-throttle + markers fallback |
| Memory pressure | Clear cache on single-system view |
| Coordinate drift | Same formula in Rust/TS with unit tests |
| Race conditions | Cancel loads on project open |

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

## Open Questions

1. **Color assignment**: Use deterministic hash from file_path?
2. **Cache eviction**: Clear on any edit or only edited project?

## Acceptance

- [ ] Global view renders shots and stations for GPS-positioned projects
- [ ] Each system has distinct auto-assigned color (stable across sessions)
- [ ] Clicking shot/station selects entire system
- [ ] Hovering shows system highlight with tooltip
- [ ] Multi-select with Ctrl+click
- [ ] Double-click opens project
- [ ] Context menu: Open, Zoom to System, Remove, Show in Folder, Merge
- [ ] Search filter dims non-matching (25% opacity) using index-of
- [ ] Keyboard shortcuts work
- [ ] Lazy loading with markers and spinners
- [ ] Fade transition (150ms)
- [ ] Error states: red marker with click-to-see popup
- [ ] View mode toggle persisted in local storage
- [ ] Auto-throttle when FPS drops
- [ ] Soft bounds with rubber-band
- [ ] **Map position/zoom persisted and restored**
- [ ] MetadataPanel shows aggregate stats (including station count)
- [ ] Projects without GPS not shown/fetched
- [ ] Rust transform matches frontend (unit tests)
- [ ] Rust config options added
- [ ] Documentation updated

## References

- `src/components/GlobalView/GlobalViewMap.tsx`
- `src/components/Map/SurveyLayer.tsx`
- `src/utils/coordinates.ts:16-31`
- `src/utils/maplibre-expressions.ts`
- [MapLibre Large Data Guide](https://maplibre.org/maplibre-gl-js/docs/guides/large-data/)
