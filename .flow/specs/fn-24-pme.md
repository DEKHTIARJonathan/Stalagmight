# Rust tile provider registry with IPC and dynamic Settings UI

## Problem

The Rust backend has tile provider logic scattered across hardcoded constants and match statements in `src-tauri/src/lib.rs`. The `SUPPORTED_PROVIDERS` array, `fetch_tile_from_network()` URL routing, and provider validation are all tightly coupled. The frontend Settings UI (`MapSettings.tsx`) maintains a separate hardcoded `SATELLITE_PROVIDER_OPTIONS` array that must be manually kept in sync with the backend.

This makes adding new tile providers error-prone and requires changes in multiple files across both Rust and TypeScript.

## Key Decisions

1. **Config-driven provider struct**: Define providers as a Rust struct with fields: `name`, `display_label`, `url_template`, `attribution`, `tile_size`, `min_zoom`, `max_zoom`, `content_type_hint`, plus optional auth fields (`api_key_env`, `auth_header`).

2. **Hardcoded in binary**: Providers are compiled into the app as a static registry. Users select from a fixed list in Settings — they cannot define custom tile server URLs.

3. **Auth support fields**: Include `api_key_env` (environment variable name for API key) and `auth_header` (HTTP header name) in the struct. ESRI doesn't use these, but the fields exist for future providers like Mapbox.

4. **`get_tile_providers` IPC command**: New Tauri command that returns all registered providers with an `available` flag indicating whether the provider is configured and ready (e.g., has required API key). Frontend uses this to populate the Settings UI dynamically.

5. **Return all providers**: The IPC command returns every registered provider, not just usable ones. The frontend can show unavailable providers as disabled with a "requires API key" hint.

6. **ESRI only initially**: Ship with ESRI as the only provider in the registry. Auth fields exist in the struct but no provider uses them yet.

7. **Replace hardcoded constants**: Remove `SUPPORTED_PROVIDERS` array, `ESRI_TILE_URL` constant, and the match statement in `fetch_tile_from_network()`. Replace with registry lookups.

8. **Frontend dynamic Settings UI**: Remove hardcoded `SATELLITE_PROVIDER_OPTIONS` from `MapSettings.tsx`. Instead, fetch providers via `get_tile_providers` on mount and populate the dropdown dynamically.

9. **Frontend utility integration**: Update `src/utils/tileConfig.ts` (created in fn-23-q2y) to optionally consume provider metadata from the IPC command rather than maintaining a separate frontend provider map.

10. **Comprehensive testing**: Unit tests for the Rust provider registry, IPC command serialization, and frontend Settings UI population.

## Dependencies

- **Depends on fn-23-q2y**: The shared tile config utility (`src/utils/tileConfig.ts`) and config defaults fix are created in that epic. This epic builds on top of it.

## Scope

### In scope
- Rust `TileProvider` struct with all fields (name, display_label, url_template, attribution, tile_size, min_zoom, max_zoom, content_type_hint, api_key_env, auth_header)
- Static provider registry (e.g., `lazy_static` or `const` array)
- Refactor `fetch_tile_from_network()` to use registry lookup instead of match statement
- Refactor `handle_tile_request()` provider validation to use registry
- New `get_tile_providers` IPC command returning serialized provider list with availability flags
- Update `MapSettings.tsx` to fetch and render providers dynamically
- Remove hardcoded `SATELLITE_PROVIDER_OPTIONS` from `MapSettings.tsx`
- Update `src/utils/tileConfig.ts` to consume backend provider metadata
- Rust unit tests for registry, URL template expansion, provider lookup
- TypeScript tests for Settings UI provider population
- Integration test for IPC command

### Out of scope
- Adding additional providers beyond ESRI (future work)
- Runtime plugin system for custom providers
- User-defined custom tile server URLs in config
- API key management UI (future, when auth-requiring providers are added)

## Edge Cases

- **Empty registry**: Should never happen (ESRI is always present), but handle gracefully — return empty list from IPC, show "No providers available" in Settings
- **Provider removed between versions**: If a user's config references a provider that no longer exists in the registry, fall back to ESRI and log a warning
- **URL template expansion failure**: If a provider's URL template is malformed, return a clear error from `fetch_tile_from_network()`
- **IPC command called before app fully initialized**: Ensure the registry is available immediately (static/const, not async-initialized)
- **Concurrent provider queries**: Registry is read-only after initialization — no locking needed

## Open Questions

- Should the `url_template` use `{z}/{y}/{x}` placeholders or a different format? (Most tile servers use this convention)
- Should provider metadata include a `test_tile_url` for connectivity checks (used by `get_network_status`)?
- Should the availability check for auth-requiring providers verify the env var exists at startup or on each `get_tile_providers` call?

## Acceptance

- [ ] `TileProvider` Rust struct with all fields: name, display_label, url_template, attribution, tile_size, min_zoom, max_zoom, content_type_hint, api_key_env, auth_header
- [ ] Static provider registry with ESRI as the sole provider
- [ ] `fetch_tile_from_network()` uses registry lookup (no hardcoded URL/match)
- [ ] `handle_tile_request()` validates against registry (no `SUPPORTED_PROVIDERS` array)
- [ ] `get_tile_providers` IPC command returns all providers with `available` flag
- [ ] `MapSettings.tsx` populates provider dropdown from IPC (no hardcoded list)
- [ ] `src/utils/tileConfig.ts` updated to use backend provider metadata
- [ ] Rust unit tests for: registry lookup, URL template expansion, unknown provider handling, provider struct serialization
- [ ] Frontend test for Settings UI dynamic provider loading
- [ ] All existing tile-related tests pass
- [ ] Provider fallback works when config references unknown provider name
