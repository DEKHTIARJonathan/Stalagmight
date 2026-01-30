# fn-51-g8j.4 Add AppearanceConfig to TypeScript and Rust config systems

## Description

Add a new `appearance` config section with a `theme` field (`'dark' | 'light' | 'auto'`) to both the TypeScript and Rust config systems.

## Files to modify

- `src/types/config.ts` — Add `AppearanceConfig` interface and `ThemeMode` type, add to `Config` interface and `defaultConfig`
- `src-tauri/src/config/types.rs` — Add `AppearanceConfig` struct, add to `Config` struct
- `src-tauri/src/config/defaults.rs` — Add `Default` impl for `AppearanceConfig`

## Implementation

### TypeScript (`src/types/config.ts`)

Add type and interface:
```typescript
export type ThemeMode = 'dark' | 'light' | 'auto';

export interface AppearanceConfig {
  theme: ThemeMode;
}
```

Add to `Config` interface:
```typescript
export interface Config {
  // ... existing fields ...
  appearance: AppearanceConfig;
}
```

Add to `defaultConfig`:
```typescript
export const defaultConfig: Config = {
  // ... existing fields ...
  appearance: {
    theme: 'dark',
  },
};
```

### Rust (`src-tauri/src/config/types.rs`)

Add struct:
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppearanceConfig {
    #[serde(default = "default_theme")]
    pub theme: String,
}

fn default_theme() -> String {
    "dark".to_string()
}
```

Add to `Config` struct:
```rust
pub struct Config {
    // ... existing fields ...
    #[serde(default)]
    pub appearance: AppearanceConfig,
}
```

### Rust Defaults (`src-tauri/src/config/defaults.rs`)

```rust
impl Default for AppearanceConfig {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
        }
    }
}
```

### Normalization

Add to `Config::normalize()` method: validate that `appearance.theme` is one of `"dark"`, `"light"`, `"auto"`, defaulting to `"dark"` if invalid.

## Acceptance

- [ ] `AppearanceConfig` with `theme` field exists in TypeScript
- [ ] `ThemeMode` type alias defined as `'dark' | 'light' | 'auto'`
- [ ] `defaultConfig.appearance.theme` is `'dark'`
- [ ] Rust `AppearanceConfig` struct matches TypeScript
- [ ] `#[serde(default)]` on the field so existing config files without `[appearance]` section load correctly
- [ ] Normalization rejects invalid theme values
- [ ] `pnpm tsc --noEmit` passes
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] Existing config files load without error (backward compatible)
