# fn-12-szd.1 Add animation config to Rust and TypeScript

## Description
Add `MapAnimationConfig` to both Rust config schema and TypeScript types. This provides configurable animation settings for map focus transitions.

**Size:** S
**Files:** `src-tauri/src/config/mod.rs`, `src-tauri/src/config/defaults.rs`, `src/types/config.ts`

## Approach

- Follow existing `MapConfig` pattern at `src/types/config.ts:104`
- Add `MapAnimationConfig` struct to `src-tauri/src/config/mod.rs` with `#[serde(default)]` for each field
- Add default values to `src-tauri/src/config/defaults.rs`
- Add TypeScript interface `MapAnimationConfig` with matching fields
- Update `defaultConfig` in TypeScript with animation defaults
- Default values: `enabled: true`, `duration: 300`, `point_zoom: 18`

## Key context

- Rust config uses `#[serde(default)]` per-field for forward compatibility (from memory)
- Config struct is in `mod.rs`, defaults in `defaults.rs`
- TypeScript config loaded via Tauri invoke at app startup
## Approach

- Follow existing `MapConfig` pattern at `src/types/config.ts:104`
- Add `animation` field to `MapConfig` struct in Rust with `#[serde(default)]` for each field
- Add TypeScript interface `MapAnimationConfig` with matching fields
- Default values: `enabled: true`, `duration: 300`, `point_zoom: 18`

## Key context

- Rust config uses `#[serde(default)]` per-field for forward compatibility (from memory)
- TypeScript config loaded via Tauri invoke at app startup
## Acceptance
- [ ] `MapAnimationConfig` struct added to `src-tauri/src/config/mod.rs`
- [ ] Default impl added to `src-tauri/src/config/defaults.rs`
- [ ] `animation` field added to `MapConfig` in Rust
- [ ] `MapAnimationConfig` interface added to `src/types/config.ts`
- [ ] `animation` field added to `MapConfig` in TypeScript
- [ ] `defaultConfig.map.animation` populated with defaults
- [ ] Default values: enabled=true, duration=300, point_zoom=18
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] `pnpm tsc --noEmit` passes
## Done summary
Added MapAnimationConfig struct to Rust config with serde defaults (enabled=true, duration=300, point_zoom=18) and corresponding TypeScript interface, following existing per-field serde(default) pattern for forward compatibility.
## Evidence
- Commits: 333faf1e45b08bd342a6b88da7bef1e1fd2b569c
- Tests: cargo test --manifest-path src-tauri/Cargo.toml, pnpm tsc --noEmit
- PRs: