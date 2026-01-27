# fn-24-pme.1 TileProvider struct and static registry module

## Description

Create a new Rust module `src-tauri/src/tile_providers.rs` containing the `TileProvider` struct, `TileProviderInfo` response DTO, and a static registry. The registry holds all known tile providers (initially ESRI only) and provides lookup, listing, and URL template expansion.

**Size:** M
**Files:** `src-tauri/src/tile_providers.rs` (new), `src-tauri/src/lib.rs` (mod declaration)

## Approach

- Define `TileProvider` struct (internal) with fields: `name`, `display_label`, `url_template`, `attribution`, `tile_size` (u32), `min_zoom` (u32), `max_zoom` (u32), `content_type_hint`, `api_key_env` (Option<String>), `auth_header` (Option<String>)
- Define `TileProviderInfo` response DTO (serializable) with all `TileProvider` fields plus `available: bool`. This is the type returned by the IPC command.
- Derive `Debug, Clone, Serialize, Deserialize` on both types — follow pattern at `src-tauri/src/commands/cache.rs:14-33`
- Use `std::sync::OnceLock<HashMap<String, TileProvider>>` for the static registry (not `lazy_static` — deprecated per practice-scout)
- ESRI provider entry:
  - `name: "esri"`, `display_label: "ESRI World Imagery"`
  - `url_template: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"`
  - `attribution: "© Esri, Maxar, Earthstar Geographics"`, `tile_size: 256`, `min_zoom: 1`, `max_zoom: 22`, `content_type_hint: "image/jpeg"`
  - `api_key_env: None`, `auth_header: None`
- Provide public functions:
  - `get_provider(name: &str) -> Option<&TileProvider>` — registry lookup
  - `get_all_provider_info() -> Vec<TileProviderInfo>` — returns all providers with computed `available` flag
  - `expand_url(provider: &TileProvider, z: u32, y: u32, x: u32) -> String` — URL template expansion
- URL expansion: simple `str::replace()` chain for `{z}`, `{y}`, `{x}` placeholders
- `available` computation: `true` if `api_key_env` is `None`, otherwise `std::env::var(key).is_ok()`
- Add `pub mod tile_providers;` in `src-tauri/src/lib.rs` (NOT main.rs — main.rs only calls `cavechef_lib::run()`)

## Key context

- Use `OnceLock` (std, Rust 1.80+) not `lazy_static` (deprecated). Pattern: `static REGISTRY: OnceLock<HashMap<...>> = OnceLock::new();` with `get_or_init()`
- Per memory-scout: config structs need per-field `#[serde(default)]` for forward compatibility
- Module must be declared in `lib.rs` because that is the crate root; `main.rs` only calls `cavechef_lib::run()`

## Test notes

- Unit tests in same file under `#[cfg(test)] mod tests`
- Test: registry lookup returns ESRI provider by name
- Test: registry lookup returns None for unknown provider
- Test: URL template expansion produces correct URL for given z/y/x
- Test: `get_all_provider_info()` returns non-empty vec with `available: true` for ESRI
- Test: `TileProviderInfo` serializes to expected JSON shape (includes `available` field)
- Test: provider with `api_key_env: Some("MISSING_VAR")` has `available: false`

## Acceptance
- [ ] `TileProvider` struct defined with all spec fields (name, display_label, url_template, attribution, tile_size, min_zoom, max_zoom, content_type_hint, api_key_env, auth_header)
- [ ] `TileProviderInfo` response DTO defined with all TileProvider fields + computed `available: bool`
- [ ] Both structs derive Debug, Clone, Serialize, Deserialize
- [ ] Static registry initialized via OnceLock with ESRI provider
- [ ] `get_provider(name)` returns Option<&TileProvider>
- [ ] `get_all_provider_info()` returns Vec<TileProviderInfo> with computed availability
- [ ] `expand_url()` replaces {z}/{y}/{x} placeholders correctly
- [ ] Module declared as `pub mod tile_providers` in `src-tauri/src/lib.rs`
- [ ] Unit tests pass: lookup, unknown provider, URL expansion, TileProviderInfo serialization, availability computation
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
