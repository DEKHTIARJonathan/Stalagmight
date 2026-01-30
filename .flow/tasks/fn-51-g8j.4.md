# fn-51-g8j.4 Add AppearanceConfig to TypeScript and Rust config systems

## Description

Add a new `appearance` config section with a `theme` field (`'dark' | 'light' | 'auto'`) to both the TypeScript and Rust config systems. Also update the config deep-merge plumbing in SettingsDialog and the E2E mock config.

**Size:** M
**Files:**
- `src/types/config.ts`
- `src-tauri/src/config/types.rs`
- `src-tauri/src/config/defaults.rs`
- `src/components/Dialogs/SettingsDialog.tsx` (internal `mergeConfig()` and `getCategoryDefaults()`)
- `e2e-playwright/mocks/tauri-ipc.ts`
- `src/types/__tests__/config.test.ts` (update test expectations for new `appearance` key)

## Approach

- Add `ThemeMode` type and `AppearanceConfig` interface to TypeScript config
- Add corresponding Rust struct with `#[serde(default)]` for backward compatibility
- Add `'appearance'` case to `getCategoryDefaults()` (internal function at ~lines 65-105 in SettingsDialog.tsx)
- Add `appearance` branch to `mergeConfig()` (internal function at ~lines 183-283 in SettingsDialog.tsx)
- Add `appearance: { theme: 'dark' }` to **both** `get_config` and `reload_config` mock handlers in `e2e-playwright/mocks/tauri-ipc.ts` (both return full config objects)
- Both `mergeConfig()` and `getCategoryDefaults()` are **internal functions** (not exported) within SettingsDialog.tsx
- Add `AppearanceConfig::normalize()` in Rust: invalid theme values reset to `"dark"`. Call from `Config::normalize()`
- Update `src/types/__tests__/config.test.ts` to include `appearance` in expected top-level keys

## Key context

- `mergeConfig()` does field-by-field deep merging; `appearance` needs its own branch
- `getCategoryDefaults()` uses a switch statement; add `'appearance'` case returning `{ appearance: defaultConfig.appearance }`
- E2E mock at `e2e-playwright/mocks/tauri-ipc.ts` hardcodes config return values in **both** `get_config` and `reload_config` handlers — must add `appearance` field to both or tests crash when `Config` type requires it
- Rust uses `#[serde(default)]` so existing TOML configs without `[appearance]` still load

## Acceptance

- [ ] `AppearanceConfig` with `theme` field exists in TypeScript
- [ ] `ThemeMode` type alias defined as `'dark' | 'light' | 'auto'`
- [ ] `defaultConfig.appearance.theme` is `'dark'`
- [ ] Rust `AppearanceConfig` struct matches TypeScript
- [ ] `#[serde(default)]` on the field so existing config files without `[appearance]` section load correctly
- [ ] Rust `AppearanceConfig::normalize()` resets invalid theme values to `"dark"`, called from `Config::normalize()`
- [ ] `mergeConfig()` in SettingsDialog.tsx handles `appearance` field
- [ ] `getCategoryDefaults()` in SettingsDialog.tsx returns appearance defaults
- [ ] E2E mock config in `e2e-playwright/mocks/tauri-ipc.ts` includes `appearance: { theme: 'dark' }` in **both** `get_config` and `reload_config` handlers
- [ ] `pnpm tsc --noEmit` passes
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] Existing config files load without error (backward compatible)
- [ ] `src/types/__tests__/config.test.ts` updated to include `appearance` in expected keys

## Done summary

(To be filled on completion)

## Evidence

(To be filled on completion)
