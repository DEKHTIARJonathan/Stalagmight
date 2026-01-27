# fn-23-q2y.3 Fix config defaults and update documentation

## Description

Fix incorrect config defaults from "openstreetmap" to "esri" in both Rust and TypeScript, and update documentation references.

**Size:** S
**Files:** `src-tauri/src/config/defaults.rs`, `src/types/config.ts`, `docs/architecture.md`, `docs/SPEC.md`

## Approach

- Change `satellite_provider` default from `"openstreetmap"` to `"esri"` in `src-tauri/src/config/defaults.rs:94`
- Change `satellite_provider` default from `'openstreetmap'` to `'esri'` in `src/types/config.ts:285`
- Update `docs/architecture.md:133` — change "Initializes MapLibre with OSM tiles" to reference ESRI satellite tiles
- Update `docs/SPEC.md:~1433-1436` — change `satellite_provider = "openstreetmap"` to `satellite_provider = "esri"` in config example

## Key context

- Backend only supports `"esri"` in `SUPPORTED_PROVIDERS` (`src-tauri/src/lib.rs:32`)
- Settings UI only shows ESRI option (`src/components/Dialogs/settings/MapSettings.tsx:10-14`)
- `docs/configuration.md` already shows `satellite_provider = "esri"` (no update needed)
- This is a bug fix — defaults never matched the actual supported provider
## Acceptance
- [ ] Rust default `satellite_provider` is `"esri"` in `config/defaults.rs`
- [ ] TypeScript default `satellite_provider` is `'esri'` in `types/config.ts`
- [ ] `docs/architecture.md` references ESRI satellite tiles (not OSM)
- [ ] `docs/SPEC.md` config example shows `satellite_provider = "esri"`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] `pnpm tsc --noEmit` passes
## Done summary
Fixed satellite_provider default from "openstreetmap" to "esri" in both Rust (defaults.rs) and TypeScript (config.ts), updated unit test assertion to match, and improved documentation accuracy in architecture.md and SPEC.md.
## Evidence
- Commits: 0e55e8c, 42d174a
- Tests: cargo test --manifest-path src-tauri/Cargo.toml, pnpm tsc --noEmit
- PRs: