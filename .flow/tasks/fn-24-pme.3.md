# fn-24-pme.3 Dynamic Settings UI and frontend tileConfig integration

## Description

Update the frontend to dynamically fetch tile providers from the backend via the `get_tile_providers` IPC command. Remove the hardcoded `SATELLITE_PROVIDER_OPTIONS` from `MapSettings.tsx` and update `tileConfig.ts` to consume backend provider metadata.

**Size:** M
**Files:** `src/components/Dialogs/settings/MapSettings.tsx`, `src/utils/tileConfig.ts`, `src/types/tile.ts` (new), `e2e-playwright/mocks/tauri-ipc.ts`

## Approach

### TypeScript types
- Create `src/types/tile.ts` with `TileProviderInfo` interface matching the Rust `TileProviderInfo` DTO shape (name, display_label, url_template, attribution, tile_size, min_zoom, max_zoom, content_type_hint, api_key_env, auth_header, available)
- Follow existing type patterns at `src/types/cache.ts:1-26`

### MapSettings.tsx changes
- Remove `SATELLITE_PROVIDER_OPTIONS` constant (lines 10-14)
- On mount, call `invoke<TileProviderInfo[]>('get_tile_providers')` to fetch providers
- Map response to Select options: `{ value: provider.name, label: provider.display_label }`
- Disable unavailable providers in the dropdown (show "requires API key" hint)
- Error handling: if IPC call fails, fall back to a single `{ value: 'esri', label: 'ESRI World Imagery' }` entry
- Follow invoke pattern at `src/components/Dialogs/settings/CacheSettings.tsx:93-115`

### tileConfig.ts integration
- Update `tileConfig.ts` (created by fn-23-q2y) to optionally consume provider metadata from the IPC command
- The utility should accept provider metadata (attribution, tile_size, min/max zoom) to configure tile sources
- If metadata not provided, fall back to current hardcoded defaults (backward compatible)
- **Important**: `tileConfig.ts` continues to use the `cavechef-tiles://{provider}/{z}/{y}/{x}` custom protocol for tile URLs (this routes through the Rust backend for SQLite caching and offline support). The `url_template` from provider metadata is NOT used directly by the frontend — it is only used by the Rust backend inside `fetch_tile_from_network()`. The frontend consumes only metadata fields: `attribution`, `tile_size`, `min_zoom`, `max_zoom`.

### E2E test mock
- Add `get_tile_providers` case to `e2e-playwright/mocks/tauri-ipc.ts`
- Return mock ESRI provider with `available: true` using `TileProviderInfo` shape
- Follow existing mock pattern (e.g., `get_cache_stats` case)

### Doc updates
- Update `docs/SPEC.md`: add `get_tile_providers` to IPC command list in Section 13.5
- Update `docs/architecture.md`: add `tile_providers.rs` to key files table
- Update `docs/configuration.md`: note that `satellite_provider` selects from backend registry

## Key context

- Depends on fn-23-q2y completing (tileConfig.ts must exist). If fn-23-q2y is not merged, the tileConfig.ts part should be skipped and tracked as a follow-up.
- E2E settings tests currently skip map tab due to MapLibre render issues — no E2E regression risk
- MapSettings uses `data-testid` attributes for testing — maintain this pattern for new/changed elements
- Frontend tile URLs use `cavechef-tiles://` custom protocol (not the provider's `url_template` directly) — this is essential for SQLite caching and offline support

## Test notes

- Frontend test: MapSettings renders provider options from mocked IPC response
- Frontend test: MapSettings shows fallback option if IPC fails
- Frontend test: unavailable providers are disabled in dropdown
- E2E: verify mock is wired correctly (settings dialog can open without errors)
- `pnpm tsc --noEmit` passes

## Acceptance
- [ ] `TileProviderInfo` TypeScript interface in `src/types/tile.ts` matches Rust DTO
- [ ] `SATELLITE_PROVIDER_OPTIONS` removed from MapSettings.tsx
- [ ] MapSettings.tsx fetches providers via `invoke<TileProviderInfo[]>('get_tile_providers')` on mount
- [ ] Unavailable providers shown as disabled with hint text
- [ ] Fallback to ESRI entry if IPC call fails
- [ ] `tileConfig.ts` uses only metadata fields (attribution, tile_size, min/max zoom) from IPC — NOT `url_template` (frontend continues using `cavechef-tiles://` protocol)
- [ ] `tileConfig.ts` updated to accept/use backend provider metadata (or follow-up created if fn-23-q2y not merged)
- [ ] E2E mock added for `get_tile_providers` in `tauri-ipc.ts` using `TileProviderInfo` shape
- [ ] Docs updated: SPEC.md (IPC command), architecture.md (new module), configuration.md (registry note)
- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm test:ui` passes (no E2E regressions)

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
