# Configurable Interaction Bounding Boxes for Shots and Stations

## Problem

The current interaction areas for stations (4px radius circles) and shots (2px wide lines) are too small to click accurately. Users must position their mouse precisely to select, delete, or interact with survey elements, which is frustrating and slows down workflow. This affects all tools equally: select, delete, merge, measure, and draw.

## Approach

Implement invisible "hitbox" layers rendered beneath the visual layers. These hitbox layers use larger sizes (configurable) while the visual appearance remains unchanged. MapLibre's `queryRenderedFeatures` will detect clicks/hovers on the hitbox layers, providing a larger interactive area without changing the visual design.

### Technical Implementation

1. **Transparent Hitbox Layers**: Add two new MapLibre layers:
   - `survey-stations-hitbox`: Circle layer with `circle-radius` set to `map.station.hitArea` (default 10px)
   - `survey-shots-hitbox`: Line layer with `line-width` set to `map.shot.hitArea` (default 8px)
   - Both layers use `opacity: 0` (fully transparent) by default
   - Same GeoJSON source as visual layers, just different paint properties

2. **Layer Order**: Hitbox layers rendered first (below), visual layers on top. This ensures visual appearance is preserved while hitbox layers handle interaction queries.

3. **Event Handling**: Click and hover events registered on hitbox layers, not visual layers. Station hitbox has priority over shot hitbox (current behavior preserved).

4. **Ghost Layers**: Ghost/preview layers (used during merge) also get hitbox counterparts with same settings.

5. **Debug Mode**: When `debug.map.showHitboxes` is true, render hitbox layers with `rgba(255, 0, 0, 0.3)` instead of transparent.

### Configuration Schema

**New settings in `[map]` section:**

```toml
[map.station]
radius = 4              # Visual size (pixels) - was display.station_size
hitArea = 10            # Clickable area radius (pixels)

[map.shot]
width = 2               # Visual width (pixels) - was display.line_thickness
hitArea = 8             # Clickable area width (pixels)

[map.snap]
threshold = 10          # Snap radius (pixels) - was snap.threshold_pixels
enabledDraw = true      # was snap.enabled_draw
enabledMerge = true     # was snap.enabled_merge
enabledMeasure = true   # was snap.enabled_measure

[debug.map]
showHitboxes = false    # Show red overlay for hitbox areas
logHitDetection = false # Log hit detection events to console
```

**Validation bounds:**
- Station settings (radius, hitArea): 1-50px
- Shot settings (width, hitArea): 0.5-20px
- Snap threshold: 1-50px

**Removed settings (clean break migration):**
- `display.station_size` → `map.station.radius`
- `display.line_thickness` → `map.shot.width`
- `snap.enabled_draw` → `map.snap.enabledDraw`
- `snap.enabled_merge` → `map.snap.enabledMerge`
- `snap.enabled_measure` → `map.snap.enabledMeasure`
- `snap.threshold_pixels` → `map.snap.threshold`

### Config Reload

- Add "Reload Config" button to Settings dialog footer
- When clicked, re-read config file and apply changes immediately
- Show toast notification listing which settings changed

## Edge Cases

- **Dense surveys**: Stations have priority when multiple elements overlap. Fixed hit areas (not zoom-dependent) for simplicity.
- **Performance**: Trust MapLibre's spatial indexing initially. Benchmark with large surveys and optimize only if needed.
- **Config file missing keys**: Use defaults for any missing settings (config always generated with all keys).

## Quick Commands

```bash
# Type check
pnpm tsc --noEmit

# Run Playwright E2E tests
pnpm test:ui

# Run Rust tests
cargo test --manifest-path src-tauri/Cargo.toml
```

## Acceptance Criteria

- [ ] Stations can be clicked/hovered within configurable hitArea radius (default 10px)
- [ ] Shots can be clicked/hovered within configurable hitArea width (default 8px)
- [ ] Visual rendering sizes unchanged (station 4px radius, shot 2px width by default)
- [ ] All settings configurable via `~/.config/cavechef/config.toml`
- [ ] Settings apply immediately when "Reload Config" clicked in Settings dialog
- [ ] Toast shows changed settings on config reload
- [ ] Debug mode (`debug.map.showHitboxes`) shows red overlay for hitbox areas
- [ ] Debug logging (`debug.map.logHitDetection`) logs hit events when enabled
- [ ] Old settings (`display.station_size`, `display.line_thickness`, `snap.*`) removed
- [ ] TypeScript and Rust config types updated and synchronized
- [ ] Unit tests for config loading, validation, and defaults
- [ ] E2E tests verify exact pixel distance hit detection (hitArea-1 hits, hitArea+1 misses)
- [ ] docs/configuration.md updated with new settings
- [ ] Ghost layers use same hitArea settings
- [ ] All validation bounds enforced (station 1-50px, shot 0.5-20px)
