# fn-4-7mg.7 Add unit tests for config loading and validation

## Description
Add unit tests for the new config schema, loading, and validation.

## Rust Tests (`src-tauri/src/config/`)

### Test Cases

1. **Default values**: Verify all defaults match expected values
   - `map.station.radius` = 4
   - `map.station.hitArea` = 10
   - `map.shot.width` = 2
   - `map.shot.hitArea` = 8
   - `map.snap.threshold` = 10
   - etc.

2. **Validation bounds**:
   - Station radius/hitArea: accept 1, 25, 50; reject 0, -1, 51, 100
   - Shot width/hitArea: accept 0.5, 10, 20; reject 0, -1, 21, 100
   - Snap threshold: accept 1, 25, 50; reject 0, -1, 51

3. **Config parsing**: Test TOML parsing with:
   - Complete config file
   - Partial config (missing sections use defaults)
   - Invalid values (should error or use defaults)

4. **Serialization**: Test config serializes to TOML correctly

### TypeScript Tests (`src/types/__tests__/`)

1. **Default config**: Verify `defaultConfig` matches expected structure
2. **Type guards**: If any type guards exist, test them

## Test Files

- Rust: `src-tauri/src/config/tests.rs` or `mod.rs` with `#[cfg(test)]`
- TypeScript: `src/types/__tests__/config.test.ts`
## Acceptance
- [ ] Rust test for default values
- [ ] Rust test for validation bounds (station)
- [ ] Rust test for validation bounds (shot)
- [ ] Rust test for validation bounds (snap)
- [ ] Rust test for config parsing
- [ ] Rust test for config serialization
- [ ] TypeScript test for defaultConfig structure
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] All new tests pass
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
