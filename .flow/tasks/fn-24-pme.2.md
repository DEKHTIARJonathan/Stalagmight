# fn-24-pme.2 Refactor tile fetch logic and add get_tile_providers IPC command

## Description

Refactor `fetch_tile_from_network()`, `handle_tile_request()`, and `tile_fetch_impl()` in `src-tauri/src/lib.rs` to use the new tile provider registry from Task 1. Remove hardcoded constants. Add a new `get_tile_providers` IPC command. Add config normalization for unknown provider names.

**Size:** M
**Files:** `src-tauri/src/lib.rs`, `src-tauri/src/commands/cache.rs` (or new `tile.rs` command module)

## Approach

### Refactor tile fetch
- Remove `ESRI_TILE_URL` constant (line 20) and `SUPPORTED_PROVIDERS` array (line 32)
- In `fetch_tile_from_network()` (line 35-69): replace hardcoded URL format with `tile_providers::get_provider(provider)` lookup + `expand_url()`. Return descriptive error for unknown provider.
- In `handle_tile_request()` (line 185-191): replace `SUPPORTED_PROVIDERS.contains()` with `tile_providers::get_provider(provider).is_some()`. Return error for unknown provider.
- In `tile_fetch_impl()` (line 266-271): same registry-based validation. Return error for unknown provider.
- All tile fetch paths return errors for unknown providers — these should never receive invalid providers after config normalization.

### Error vs fallback strategy (two distinct behaviors)
- **Config normalization** (app startup / config load): If `satellite_provider` references an unknown provider, normalize to `"esri"` and log a warning. Add normalization logic in config loading path (e.g., `MapConfig::normalize()` or during config deserialization).
- **Tile fetch API** (`fetch_tile_from_network`, `handle_tile_request`, `tile_fetch_impl`): Return a descriptive error for unknown providers. These calls should never see invalid providers after normalization.

### IPC command
- New `#[tauri::command] pub fn get_tile_providers() -> Vec<TileProviderInfo>` — calls `tile_providers::get_all_provider_info()`
- `TileProviderInfo` is the response DTO defined in Task 1 (TileProvider fields + computed `available: bool`)
- Follow command pattern at `src-tauri/src/commands/cache.rs:36-77`
- Register in `invoke_handler` at `src-tauri/src/lib.rs:405-475`
- No state access needed — registry is static

## Key context

- Provider validation currently happens in TWO places (`handle_tile_request` line 185, `tile_fetch_impl` line 266). Both must be updated.
- Commands registered via `tauri::generate_handler![]` macro — add new command to the list
- Tauri v2 uses `@tauri-apps/api/core` for invoke (not `@tauri-apps/api/tauri`)
- Config normalization ensures tile fetch paths never receive unknown providers, so they can safely return errors (not fallbacks)

## Test notes

- Update existing tile fetch tests to work without hardcoded constants
- New tests: fetch with valid provider uses registry URL, fetch with unknown provider returns error
- Test: config normalization replaces unknown provider with "esri"
- Test: get_tile_providers returns Vec<TileProviderInfo> with ESRI having available=true
- Test: get_tile_providers response serializes correctly
- All existing tests in `src-tauri/src/lib.rs:480-1213` must still pass

## Acceptance
- [ ] `ESRI_TILE_URL` and `SUPPORTED_PROVIDERS` constants removed from lib.rs
- [ ] `fetch_tile_from_network()` uses registry lookup + `expand_url()` for tile URLs
- [ ] `handle_tile_request()` validates provider against registry (returns error for unknown)
- [ ] `tile_fetch_impl()` validates provider against registry (returns error for unknown)
- [ ] Config normalization: unknown `satellite_provider` normalized to "esri" with logged warning
- [ ] `get_tile_providers` IPC command registered, returns `Vec<TileProviderInfo>`
- [ ] All existing tile-related tests still pass
- [ ] New tests: registry-based fetch, unknown provider error, config normalization, IPC response serialization
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
