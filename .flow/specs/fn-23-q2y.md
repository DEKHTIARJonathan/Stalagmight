# Global map: switch from OSM to shared satellite tile provider

## Overview

Replace the hardcoded OpenStreetMap raster tiles in GlobalViewMap with ESRI satellite imagery via the existing `cavechef-tiles://` protocol. Centralize tile configuration in a shared utility so both GlobalViewMap and MapCanvas use a single source of truth. Fix config defaults that incorrectly say "openstreetmap" when only "esri" is supported.

## Scope

- New shared utility `src/utils/tileConfig.ts` (provider-aware tile config function)
- GlobalViewMap: swap OSM → ESRI satellite (always-on, no toggle)
- MapCanvas: refactor to delegate to shared utility
- Config defaults: "openstreetmap" → "esri" in Rust + TypeScript
- Zoom clamping on restored map state
- Doc updates (architecture.md, SPEC.md)
- Unit tests for shared utility; update broken E2E tests

**Out of scope**: Rust provider registry, dynamic Settings UI, auth support, overlay styling changes on satellite background.

## Key context

- `cavechef-tiles://esri/{z}/{y}/{x}` protocol already exists with SQLite caching + offline fallback (`src-tauri/src/lib.rs:340-376`)
- GlobalViewMap OSM config: `src/components/GlobalView/GlobalViewMap.tsx:363-385`
- MapCanvas satellite config: `src/components/Map/MapCanvas.tsx:1140-1208` (`getSatelliteTileConfig` useCallback)
- Config defaults: `src-tauri/src/config/defaults.rs:94`, `src/types/config.ts:285`
- ESRI tileSize is 256; max zoom typically 0-23
- fn-24-pme (provider registry epic) depends on this epic
- fn-35-v6w (dark theme controls) touches same GlobalViewMap file but different sections

## Quick commands

```bash
pnpm tsc --noEmit
pnpm test:ui
cargo test --manifest-path src-tauri/Cargo.toml
```

## Acceptance

- [ ] GlobalViewMap renders ESRI satellite tiles via `cavechef-tiles://esri/{z}/{y}/{x}`
- [ ] Satellite tiles always displayed in global view (no toggle)
- [ ] `showSatellite` uiStore toggle has no effect on global view
- [ ] New shared utility `src/utils/tileConfig.ts` exports provider-aware tile config
- [ ] MapCanvas delegates to shared utility (no duplicated config)
- [ ] Utility returns tiles, attribution, tileSize, minZoom, maxZoom
- [ ] Utility throws on unknown provider name
- [ ] GlobalViewMap clamps restored zoom to provider's supported range
- [ ] ESRI attribution displayed on global map
- [ ] Config defaults changed to "esri" in both Rust and TypeScript
- [ ] Docs updated (architecture.md, SPEC.md)
- [ ] All existing tests pass; broken tests updated
- [ ] New unit tests for shared tile config utility
