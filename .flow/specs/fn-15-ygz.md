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

**Out of scope:**
- Individual shot/station selection in global view
- Editing operations in global view
- Loop closures and merge connection visualization
- Station name labels (only system name shown)

## Approach

### Backend Changes
1. New Tauri command `get_survey_geometry` returns lightweight GPS-transformed data:
   ```rust
   struct SurveyGeometry {
     file_path: String,
     gps_origin: [f64; 2],  // [lng, lat]
     shots: Vec<ShotLine>,   // [[from_lng, from_lat], [to_lng, to_lat]]
     stations: Vec<[f64; 2]>, // [lng, lat] positions
     is_virtual: Vec<bool>,  // parallel to shots
   }
   ```

2. Frontend filters virtual shots before rendering

### Frontend Changes
1. Create `GlobalSurveyLayer` class (simplified from `SurveyLayer`) for read-only multi-system rendering
2. Use GeoJSON sources with `tolerance: 0.5` for MapLibre simplification
3. Avoid `setFeatureState` for hover/selection (use filter-based highlighting per best practices)
4. Implement FPS monitoring with `requestAnimationFrame` timing
5. Add search filter component in GlobalView toolbar

### Key Patterns to Reuse
- `metersToMapCoords()` from `src/utils/coordinates.ts:16-31`
- Expression building from `src/utils/maplibre-expressions.ts`
- Layer styling patterns from `SurveyLayer.tsx:276-596`
- Color palette from `src/utils/colors.ts:246-255`

### Memory Pitfalls (from .flow/memory)
- Use opaque colors with tiny opacity for hitbox layers (not rgba(0,0,0,0))
- Disable MapLibre's built-in keyboard handler to prevent conflicts
- Only fire hover(false) if no other feature type is hovered
- Use refs for values in keydown handlers to avoid stale closures

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Performance with many systems | Auto-throttle reduces detail when FPS < 30; view mode toggle fallback to markers |
| Memory pressure from cached geometry | Clear cache when entering single-system view; limit cache size |
| Coordinate transform errors | Validate geometry on backend, fallback to red marker on error |
| Race conditions during lazy load | Cancel pending loads when user opens project; track load state per system |

## Quick commands
```bash
# Dev server
./scripts/dev.sh

# Type check
pnpm tsc --noEmit

# Run tests
pnpm test:ui
cargo test --manifest-path src-tauri/Cargo.toml
```

## Open Questions

1. **Color assignment algorithm**: Use deterministic hash from file_path for stable colors across sessions?
2. **Cache eviction trigger**: Clear on any project edit, or only edited project?
3. **Viewport intersection**: Use bounding box intersection or center-point-in-view?
4. **Loading count indicator**: Show "Loading 3/7 systems..." or just individual spinners?

## Acceptance

- [ ] Global view renders shots and stations for all GPS-positioned projects
- [ ] Each system has a distinct auto-assigned color (stable across sessions)
- [ ] Clicking any shot/station selects the entire system (with visual highlight)
- [ ] Hovering shows entire system highlight with tooltip (name + length + station count)
- [ ] Multi-select works with Ctrl+click
- [ ] Double-click opens the project
- [ ] Context menu shows correct options (including "Merge N Projects" when applicable)
- [ ] Search filter dims non-matching systems instantly (25% opacity)
- [ ] Keyboard shortcuts work (Enter, Delete, Escape, Ctrl+A, arrow keys)
- [ ] Survey data loads lazily with marker placeholders and spinners
- [ ] Fade transition (150ms) when survey data loads
- [ ] Error states show red markers with click-to-see-error popup
- [ ] View mode toggle (survey/markers) works and persists in local storage
- [ ] Auto-throttle reduces detail when FPS drops below configurable threshold
- [ ] Zoom/pan has soft bounds with gentle rubber-band (20% padding)
- [ ] Position/zoom is remembered across sessions (local storage)
- [ ] MetadataPanel shows aggregate stats for multi-selection
- [ ] Projects without GPS are not shown
- [ ] Performance is acceptable with 50+ systems loaded
- [ ] Documentation updated (SPEC.md, architecture.md, configuration.md, TESTING.md)

## References

- `src/components/GlobalView/GlobalViewMap.tsx` - Current marker implementation
- `src/components/Map/SurveyLayer.tsx` - Single-project survey rendering
- `src/utils/coordinates.ts:16-31` - GPS coordinate transformation
- `src/utils/maplibre-expressions.ts` - MapLibre expression builders
- [MapLibre Large Data Guide](https://maplibre.org/maplibre-gl-js/docs/guides/large-data/)
- [MapLibre transformConstrain](https://maplibre.org/maplibre-gl-js/docs/examples/customize-the-map-transform-constrain/)
