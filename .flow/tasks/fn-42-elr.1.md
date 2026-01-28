# fn-42-elr.1 Add import_dmp and export to ShortcutsConfig types

## Description
Add `import_dmp` and `export` fields to the ShortcutsConfig type in both TypeScript and Rust, with Ctrl+I and Ctrl+E as defaults.

**Size:** S
**Files:**
- `src/types/config.ts` (ShortcutsConfig interface + defaultConfig)
- `src-tauri/src/config/types.rs` (Rust ShortcutsConfig struct)
- `src-tauri/src/config/defaults.rs` (Rust defaults)

## Approach
- Follow existing shortcut field pattern at `src/types/config.ts:184-216`
- Add fields to interface with `string[]` type (supports primary + secondary shortcuts)
- Add to `defaultConfig.shortcuts` with `['Ctrl+I']` and `['Ctrl+E']`
- Rust struct uses `#[serde(deserialize_with = "deserialize_shortcut_vec")]` like other fields
- Rust defaults use `vec!["Ctrl+I".to_string()]` pattern

## Key context
- Rust and TypeScript types MUST match exactly for IPC serialization
- Shortcut values use format "Ctrl+I" (uppercase key, + separator)

## Acceptance
- [ ] `import_dmp: string[]` and `export: string[]` added to TypeScript ShortcutsConfig interface
- [ ] Defaults set to `['Ctrl+I']` and `['Ctrl+E']` in defaultConfig.shortcuts
- [ ] Rust ShortcutsConfig struct has matching fields with serde attributes
- [ ] Rust defaults match TypeScript defaults
- [ ] `pnpm tsc --noEmit` passes
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes

## Done summary
Added import_dmp and export fields to ShortcutsConfig in both TypeScript and Rust, with Ctrl+I and Ctrl+E as defaults. Updated test mocks to include new fields.
## Evidence
- Commits: 2600e55a2e7efd4d7b73d97aada6d7990de229f2
- Tests: pnpm tsc --noEmit, cargo test --manifest-path src-tauri/Cargo.toml
- PRs: