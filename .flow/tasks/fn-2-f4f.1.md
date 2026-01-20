# fn-2-f4f.1 Add zoom_step to map config

## Description
Add zoom_step configuration to Rust, TypeScript, and test mocks.

## 1. Rust: src-tauri/src/config/mod.rs

Add to MapConfig struct:
```rust
#[serde(default = "default_zoom_step")]
pub zoom_step: f64,
```

Add default function:
```rust
fn default_zoom_step() -> f64 { 1.0 }
```

Add normalize method and call from Config::load() and Config::save():
```rust
impl MapConfig {
    pub fn normalize(&mut self) {
        self.zoom_step = self.zoom_step.clamp(0.1, 5.0);
    }
}
```

## 2. Rust: src-tauri/src/config/defaults.rs

Add to Default impl for MapConfig:
```rust
zoom_step: 1.0,
```

## 3. TypeScript: src/types/config.ts

Add to MapConfig interface:
```typescript
zoom_step: number;
```

Add to defaultConfig.map:
```typescript
zoom_step: 1.0,
```

## 4. Playwright Mock: e2e-playwright/mocks/tauri-ipc.ts

Add to mock get_config map object:
```typescript
zoom_step: 1.0,
```
## Files to Modify

### 1. Rust: src-tauri/src/config/mod.rs

Add to MapConfig struct:
```rust
#[serde(default = "default_zoom_step")]
pub zoom_step: f64,
```

Add default function:
```rust
fn default_zoom_step() -> f64 { 1.0 }
```

Add normalize method:
```rust
impl MapConfig {
    pub fn normalize(&mut self) {
        self.zoom_step = self.zoom_step.clamp(0.1, 5.0);
    }
}
```

In Config::load():
```rust
let mut config = /* deserialize */;
config.map.normalize();
Ok(config)
```

In Config::save():
```rust
let mut config = self.clone();
config.map.normalize();
/* serialize and write */
```

### 2. Rust: src-tauri/src/config/defaults.rs

Add to Default impl:
```rust
zoom_step: 1.0,
```

### 3. TypeScript: src/types/config.ts

Add to MapConfig interface:
```typescript
export interface MapConfig {
  // ... existing
  zoom_step: number;
}
```

Add to defaultConfig.map:
```typescript
export const defaultConfig: Config = {
  map: {
    // ... existing
    zoom_step: 1.0,
  },
  // ...
};
```

### 4. Playwright Mock: e2e-playwright/mocks/tauri-ipc.ts

Update mock get_config response:
```typescript
map: {
  // ... existing fields
  zoom_step: 1.0,
},
```
## Rust Changes

**File: `src-tauri/src/config/mod.rs`**

Add to `MapConfig` struct:
```rust
#[serde(default = "default_zoom_step")]
pub zoom_step: f64,
```

Add default and normalize functions:
```rust
fn default_zoom_step() -> f64 { 1.0 }

impl MapConfig {
    pub fn normalize(&mut self) {
        self.zoom_step = self.zoom_step.clamp(0.1, 5.0);
    }
}
```

**Validation in BOTH paths:**

1. After `Config::load()`:
```rust
pub fn load(...) -> Result<Config, ...> {
    let mut config: Config = toml::from_str(&content)?;
    config.map.normalize(); // Clamp here
    Ok(config)
}
```

2. Before `Config::save()` or in `update_config` command:
```rust
pub fn save(&mut self) -> Result<(), ...> {
    self.map.normalize(); // Clamp before saving
    // ... write to file
}
```

**File: `src-tauri/src/config/defaults.rs`**

Add to `Default` impl for `MapConfig`:
```rust
zoom_step: 1.0,
```

## TypeScript Changes

**File: `src/types/config.ts`**

Add to `MapConfig` interface:
```typescript
zoom_step: number;
```

Add to `defaultConfig.map`:
```typescript
zoom_step: 1.0,
```

## Playwright Mocks

**File: `e2e-playwright/mocks/tauri-ipc.ts`**

Update the mock `get_config` response to include `zoom_step` in the `map` object:
```typescript
map: {
  // ... existing fields
  zoom_step: 1.0,
}
```

This prevents test breakage when code accesses `config.map.zoom_step`.
## Rust Changes

**File: `src-tauri/src/config/mod.rs` (around line 168-180)**

Add to `MapConfig` struct:
```rust
#[serde(default = "default_zoom_step")]
pub zoom_step: f64,
```

Add default function:
```rust
fn default_zoom_step() -> f64 { 1.0 }
```

**File: `src-tauri/src/config/defaults.rs` (around line 90-106)**

Add to `Default` impl for `MapConfig`:
```rust
zoom_step: 1.0,
```

**Validation (in config loading):**
- If `zoom_step < 0.1`, clamp to 0.1
- If `zoom_step > 5.0`, clamp to 5.0
- Never error, always clamp silently

## TypeScript Changes

**File: `src/types/config.ts` (around line 65-81)**

Add to `MapConfig` interface:
```typescript
zoom_step: number;
```

**File: `src/types/config.ts` (around line 186-200)**

Add to `defaultConfig.map`:
```typescript
zoom_step: 1.0,
```

## Why #[serde(default)]?

Forward compatibility: if a user has an older config file without `zoom_step`, serde will use the default function instead of erroring. This follows the convention documented in memory.
## Acceptance
- [ ] zoom_step: f64 in Rust MapConfig struct
- [ ] #[serde(default = "default_zoom_step")] attribute
- [ ] default_zoom_step() function returns 1.0
- [ ] MapConfig::normalize() clamps 0.1-5.0
- [ ] normalize() called in Config::load()
- [ ] normalize() called in Config::save()
- [ ] zoom_step: 1.0 in Rust defaults.rs
- [ ] zoom_step: number in TS MapConfig interface (src/types/config.ts)
- [ ] zoom_step: 1.0 in TS defaultConfig.map (src/types/config.ts)
- [ ] zoom_step: 1.0 in Playwright mock (e2e-playwright/mocks/tauri-ipc.ts)
- [ ] cargo test passes
- [ ] pnpm tsc --noEmit passes
## Done summary
Added zoom_step configuration to Rust MapConfig, TypeScript types, defaults, and Playwright mocks with proper NaN/inf handling in normalize().
## Evidence
- Commits: 8e6565bc0ad9c7cdff1e8f1aafb2fa23214d26e7, 31341862740b0ab9754ddb5b09f37083ff5a7d26
- Tests: cargo test --manifest-path src-tauri/Cargo.toml, pnpm tsc --noEmit, pnpm test:ui
- PRs: