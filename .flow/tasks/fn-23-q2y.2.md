# fn-23-q2y.2 Switch GlobalViewMap to ESRI satellite tiles with zoom clamping

## Description

Replace GlobalViewMap's hardcoded OpenStreetMap tile source with ESRI satellite tiles from the shared utility, and add zoom clamping for restored map positions.

**Size:** M
**Files:** `src/components/GlobalView/GlobalViewMap.tsx`, E2E test files in `e2e-playwright/`

## Approach

- Import `getTileConfig` from `src/utils/tileConfig.ts`
- Replace the inline OSM style definition (`GlobalViewMap.tsx:363-385`) with ESRI satellite config from the shared utility
- Source name: use `'satellite-tiles'` (or similar) instead of `'osm-tiles'`
- Tile URL: `cavechef-tiles://esri/{z}/{y}/{x}` (from utility)
- Attribution: `© Esri, Maxar, Earthstar Geographics` (from utility)
- tileSize: 256 (from utility)
- In `loadPersistedMapState()` (lines 12-72), clamp restored zoom to the provider's `[minZoom, maxZoom]` range using values from the utility
- Satellite is always on — no conditional logic, no `showSatellite` check, no dynamic source add/remove
- The 'B' keyboard shortcut fires `toggle_satellite` in uiStore, but GlobalViewMap doesn't read `showSatellite` so it's naturally ignored — verify this is already the case (no code change expected)
- Verify cache init timing: confirm the Rust SQLite tile cache is ready before GlobalViewMap's first tile request (Tauri lifecycle guarantees `setup()` completes before WebView mounts)
- Update any E2E tests that assert OSM URLs, OSM attribution text, or `'osm-tiles'` source/layer IDs

## Key context

- Current OSM config: `GlobalViewMap.tsx:363-385` — inline style with `'osm-tiles'` source
- Persisted state validation: `GlobalViewMap.tsx:12-72` — validates lat/lon/zoom ranges
- Current zoom validation uses [0, 22] hardcoded — replace with utility's minZoom/maxZoom
- MapLibre renders attribution from the source spec automatically (no extra control needed)
- E2E tests may reference `'osm-tiles'` layer ID or OSM attribution — check `e2e-playwright/` for these
- Memory pitfall: "Playwright tests must waitForFunction(__cavechef_map__) after canvas appears"
## Acceptance
- [ ] GlobalViewMap renders ESRI satellite tiles via `cavechef-tiles://esri/{z}/{y}/{x}`
- [ ] No OSM references remain in GlobalViewMap (no `tile.openstreetmap.org`, no `'osm-tiles'`)
- [ ] Satellite tiles always displayed (no `showSatellite` conditional)
- [ ] ESRI attribution displayed on global map
- [ ] Restored zoom clamped to provider's min/max range
- [ ] 'B' keyboard shortcut has no effect on global view (verify existing behavior)
- [ ] Cache init timing verified (no race condition)
- [ ] Global map tile fetches go through SQLite cache
- [ ] All E2E tests pass; broken assertions updated
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
