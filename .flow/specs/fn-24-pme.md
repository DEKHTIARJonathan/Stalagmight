# Rust tile provider registry with IPC and dynamic Settings UI

## Overview

Replace scattered hardcoded tile provider logic (constants, match statements, separate frontend arrays) with a centralized Rust registry and IPC command. The frontend Settings UI will dynamically populate providers from the backend instead of maintaining a parallel hardcoded list.

## Scope

### In scope
- Rust `TileProvider` struct with all fields from spec
- `TileProviderInfo` response DTO (TileProvider fields + computed `available: bool`)
- Static provider registry module (new file) with ESRI as sole provider
- URL template expansion using `{z}/{y}/{x}` placeholders
- Refactor `fetch_tile_from_network()`, `handle_tile_request()`, `tile_fetch_impl()` to use registry
- Remove `SUPPORTED_PROVIDERS`, `ESRI_TILE_URL` constants
- New `get_tile_providers` IPC command returning `Vec<TileProviderInfo>`
- Dynamic `MapSettings.tsx` provider dropdown
- `tileConfig.ts` integration with backend provider metadata
- Rust unit tests, frontend tests, E2E mock
- Doc updates (SPEC.md, architecture.md, configuration.md)

### Out of scope
- Additional providers beyond ESRI
- Runtime plugin system / custom URLs
- API key management UI
- `get_network_status` / `useNetworkStatus` ESRI endpoint hardcoding (separate concern — network health checks use a specific test URL, not the tile URL template)

## Approach

### Resolved open questions
- **URL template format**: Use `{z}/{y}/{x}` placeholders with `str::replace()` chains (standard slippy map convention)
- **Registry pattern**: Use `std::sync::OnceLock` with `HashMap` lookup (not `lazy_static` — deprecated). Practice-scout confirmed `OnceLock`/`LazyLock` are the 2025-2026 standard.
- **`available` flag**: Computed at call time in a separate `TileProviderInfo` response DTO. ESRI always `true` (no auth). Future auth providers: check `std::env::var(api_key_env).is_ok()` on each `get_tile_providers` call.
- **Module location**: New module `src-tauri/src/tile_providers.rs`, declared as `pub mod tile_providers;` in `src-tauri/src/lib.rs` (NOT main.rs — main.rs only calls `cavechef_lib::run()`).
- **Error vs fallback strategy**: Two distinct behaviors depending on call site:
  - **Config normalization** (app startup / config load): If `satellite_provider` references an unknown provider, silently normalize to `"esri"` and log a warning. This prevents broken state from persisting.
  - **Tile fetch API** (`fetch_tile_from_network`, `handle_tile_request`): Return a descriptive error for unknown providers. These are internal calls that should never receive an invalid provider after config normalization.
- **TypeScript types**: New `src/types/tile.ts` for `TileProviderInfo` interface
- **MapSettings error handling**: If `get_tile_providers` IPC fails, fall back to showing ESRI entry
- **Thread safety**: Registry is read-only static data via `OnceLock` — no locking needed

### Key patterns to follow
- Command pattern: `src-tauri/src/commands/cache.rs` (struct serialization, `#[tauri::command]`)
- Frontend invoke: `src/components/Dialogs/settings/CacheSettings.tsx:93-115` (invoke + type parameter)
- Struct pattern: derive `Debug, Clone, Serialize, Deserialize`, use `#[serde(default)]` for optional fields
- Config struct: `src-tauri/src/config/types.rs:468-494` for `MapConfig` reference
- E2E mock: `e2e-playwright/mocks/tauri-ipc.ts` (add case for `get_tile_providers`)

### Provider validation consolidation
Currently validated in TWO places:
- `handle_tile_request()` at `lib.rs:185-191`
- `tile_fetch_impl()` at `lib.rs:266-271`

Both will be replaced with a single `registry.get(provider_name)` lookup that returns `Err` for unknown providers.

### Two-type design: TileProvider vs TileProviderInfo
- `TileProvider`: Internal Rust struct representing a registered provider (name, url_template, auth fields, etc.). Used by registry internals and tile fetch logic.
- `TileProviderInfo`: Serializable response DTO for the IPC command. Contains all `TileProvider` fields plus a computed `available: bool` field. Constructed from `TileProvider` at call time by checking auth requirements.

## Risks & dependencies

| Risk | Mitigation |
|------|------------|
| fn-23-q2y not complete (creates `tileConfig.ts`) | Epic dependency set. Task 3 blocked until fn-23-q2y delivers tileConfig.ts |
| fn-29-2bf also modifies MapSettings.tsx | Changes are in different sections (label rename vs dropdown population). Low conflict risk |
| Existing tests rely on hardcoded ESRI URLs | Update test assertions to use registry lookups. Existing behavior unchanged (ESRI only) |
| E2E settings tests skip map tab | Known issue (MapLibre render). No regression risk from this change |

## Quick commands

```bash
# Rust tests (includes new registry tests)
cargo test --manifest-path src-tauri/Cargo.toml

# Type check frontend
pnpm tsc --noEmit

# E2E tests
pnpm test:ui
```

## Task summary

| # | Title | Size | Depends |
|---|-------|------|---------|
| 1 | TileProvider struct + registry module | M | — |
| 2 | Refactor tile fetch + IPC command | M | T1 |
| 3 | Dynamic Settings UI + frontend integration | M | T2, fn-23-q2y |

## Acceptance

- [ ] `TileProvider` Rust struct with all spec fields
- [ ] `TileProviderInfo` response DTO with computed `available` flag
- [ ] Static provider registry with ESRI as sole provider
- [ ] `fetch_tile_from_network()` uses registry lookup (no hardcoded URL/match)
- [ ] Provider validation consolidated (single registry lookup, returns error for unknown)
- [ ] Config normalization falls back to "esri" for unknown provider names (logged)
- [ ] `get_tile_providers` IPC command returns `Vec<TileProviderInfo>`
- [ ] `MapSettings.tsx` populates dropdown from IPC (no hardcoded list)
- [ ] `tileConfig.ts` updated to use backend provider metadata
- [ ] Rust unit tests pass (registry, URL expansion, unknown provider, serialization, TileProviderInfo construction)
- [ ] Frontend tests pass (Settings dynamic loading)
- [ ] E2E mock updated for `get_tile_providers`
- [ ] All existing tile-related tests pass
- [ ] Provider fallback works for unknown config values
- [ ] Docs updated (SPEC.md, architecture.md, configuration.md)

## References

- Existing command pattern: `src-tauri/src/commands/cache.rs:14-77`
- Config types: `src-tauri/src/config/types.rs:468-494`
- Frontend invoke: `src/components/Dialogs/settings/CacheSettings.tsx:93-115`
- Tile constants: `src-tauri/src/lib.rs:20-32`
- Tile fetch: `src-tauri/src/lib.rs:35-69`
- Provider validation: `src-tauri/src/lib.rs:185-191`, `src-tauri/src/lib.rs:266-271`
- Settings UI: `src/components/Dialogs/settings/MapSettings.tsx:10-14`
- E2E mocks: `e2e-playwright/mocks/tauri-ipc.ts`
- Tauri v2 commands: https://v2.tauri.app/develop/calling-rust/
- Tauri v2 state: https://v2.tauri.app/develop/state-management/
