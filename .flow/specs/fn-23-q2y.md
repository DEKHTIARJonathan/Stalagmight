# Global map: switch from OSM to shared satellite tile provider

## Problem

The GlobalViewMap hardcodes OpenStreetMap raster tiles as its base map, while the Single System View (MapCanvas) uses ESRI satellite imagery via the custom `cavechef-tiles://` protocol with SQLite-backed offline caching. This creates a jarring visual inconsistency between the two views and means the global map does not benefit from the existing offline tile caching system.

Additionally, the config defaults for `satellite_provider` are set to `"openstreetmap"` in both Rust (`config/defaults.rs`) and TypeScript (`types/config.ts`), despite the backend only supporting `"esri"` in `SUPPORTED_PROVIDERS` and the Settings UI only listing ESRI.

## Key Decisions

1. **Satellite always on in global view**: The global map will always display ESRI satellite tiles. There is no toggle — `showSatellite` from uiStore is ignored for the global view. The 'B' keyboard shortcut only works in single system view.

2. **Use cavechef-tiles:// protocol**: The global map switches from direct HTTP to `tile.openstreetmap.org` to the existing `cavechef-tiles://esri/{z}/{y}/{x}` protocol, gaining offline caching, stale tile fallback, and binary-efficient delivery.

3. **Inline in initial style**: Since satellite is always on, replace the OSM source with the ESRI satellite source directly in the MapLibre initial style definition (no dynamic add/remove).

4. **Standard lat/lon positioning**: The global map already works in geographic coordinates. No GPS origin transformation needed — just swap the tile source.

5. **Shared tile config utility**: Create `src/utils/tileConfig.ts` with a provider-aware plain function that returns `{ tiles, attribution, tileSize, minZoom, maxZoom }`. MapCanvas keeps its existing `useCallback` wrapper but delegates to this utility. Both views import from the same source of truth.

6. **Provider-aware from the start**: The utility accepts a provider name parameter (defaulting to 'esri') and throws on unknown providers. This prepares for a future provider registry epic without requiring a refactor.

7. **Configurable tileSize**: The utility includes tileSize in its return value (256 for ESRI) rather than hardcoding it at call sites.

8. **Zoom range in utility**: The utility returns minZoom/maxZoom per provider so GlobalViewMap can clamp restored positions on init.

9. **Zoom clamping on init**: GlobalViewMap clamps restored localStorage positions to the provider's supported zoom range, future-proofing for providers with different zoom limits.

10. **Fix config defaults**: Change `satellite_provider` default from `"openstreetmap"` to `"esri"` in both Rust (`src-tauri/src/config/defaults.rs`) and TypeScript (`src/types/config.ts`).

11. **ESRI attribution**: The global map displays `© Esri, Maxar, Earthstar Geographics` instead of `© OpenStreetMap contributors`.

12. **Cache stats shared**: Global view tile fetches count toward the same cache stats — no separate tracking.

13. **Offline behavior inherited**: The `cavechef-tiles://` protocol already handles offline fallback (serve stale cached tiles). No additional frontend work needed.

14. **No overlay styling changes**: Survey geometry and marker styling remain as-is. If visibility issues arise on satellite background, address in a separate task.

15. **Investigate cache init timing**: Verify during implementation that the Rust SQLite tile cache (initialized in AppState at startup) is ready before GlobalViewMap's first tile request.

## Scope Boundary

This epic covers the **frontend swap and config defaults fix**. A separate epic will handle:
- Rust provider registry (struct/enum with URL template, attribution, zoom range, tileSize, auth support)
- `get_tile_providers` IPC command
- Dynamic Settings UI provider list
- Auth support fields (api_key_env, auth_header)

## Edge Cases

- **No internet + no cache**: Global map shows dark/blank background (same as single view). MapLibre handles tile fetch errors gracefully. Acceptable behavior.
- **Stale cached tiles**: Served as offline fallback by the protocol handler. No frontend change needed.
- **Restored zoom out of range**: Clamped to provider's min/max zoom on init.
- **Unknown provider passed to utility**: Throws error (not a silent fallback).
- **Cache init race condition**: Needs investigation — verify AppState tile cache is initialized before WebView mounts GlobalViewMap.

## Open Questions

- Are there existing Playwright tests that assert OSM URLs or attribution text in the global map? Need to check during implementation and update if so.
- Does the cache init timing need a guard, or is the Tauri app lifecycle sufficient to guarantee readiness?

## Acceptance

- [ ] GlobalViewMap renders ESRI satellite tiles via `cavechef-tiles://esri/{z}/{y}/{x}` instead of OSM
- [ ] Satellite tiles are always displayed in global view (no toggle)
- [ ] `showSatellite` uiStore toggle has no effect on global view
- [ ] 'B' keyboard shortcut does not fire in global view
- [ ] New shared utility `src/utils/tileConfig.ts` exports provider-aware tile config function
- [ ] MapCanvas delegates to shared utility (no duplicated config)
- [ ] Utility returns tiles, attribution, tileSize, minZoom, maxZoom
- [ ] Utility throws on unknown provider name
- [ ] GlobalViewMap clamps restored zoom to provider's supported range
- [ ] ESRI attribution displayed on global map
- [ ] Rust config default changed from `"openstreetmap"` to `"esri"` in `config/defaults.rs`
- [ ] TypeScript config default changed from `"openstreetmap"` to `"esri"` in `types/config.ts`
- [ ] Global map tile fetches go through SQLite cache (visible in cache stats)
- [ ] Offline fallback works in global view (stale tiles served when offline)
- [ ] All existing tests pass; broken tests updated for new tile source
- [ ] New unit tests for shared tile config utility
- [ ] Cache init timing verified (no race condition)
