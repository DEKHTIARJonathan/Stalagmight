# fn-17-ygu.2 Fix shot-label font-size scaling

## Description

Fix the shot-label font-size to scale correctly like all other elements. Currently it's hardcoded as `font-size="8"` which is interpreted as viewBox units (meters), making it ~3-4x too large.

**Status:** Already included in fn-17-ygu.1
**Size:** S
**Files:**
- `src-tauri/src/export/image.rs` (line 397 - now contains scaling)

## Approach

Apply the same `value_world = value_px / scale` formula used for other elements:

```rust
// Implementation in fn-17-ygu.1:
let px = |pixels: f64| -> f64 { pixels / scale };
// Then used at line 397:
fs = px(8.0),   // 8px font-size
```

The scale factor helper was added at line 263, and shot-label font-size uses it at line 397.

## Key context

- CSS `font-size` in SVG without a unit is interpreted as viewBox units
- All other lengths are being scaled by `1/scale` to achieve constant pixel size
- Font sizes must follow the same pattern for consistency
- fn-17-ygu.1 included all scaling fixes including shot-label font-size

## Acceptance

- [x] Shot-label font-size is scaled: `fs = px(8.0)` at line 397
- [x] Shot labels appear at ~8px regardless of survey size
- [x] No regression in other label sizes (CSS classes also scaled)
- [x] Labels remain readable at extreme survey sizes

<!-- Updated by plan-sync: fn-17-ygu.1 already completed the shot-label font-size scaling at line 397 -->

## Done summary
## Summary

Task fn-17-ygu.2 "Add px unit to shot-label font-size" was **already completed** as part of fn-17-ygu.1.

### Implementation Details

The shot-label font-size scaling was implemented in `src-tauri/src/export/image.rs`:
- Line 263: `let px = |pixels: f64| -> f64 { pixels / scale };` - pixel-to-world conversion helper
- Line 397: `fs = px(8.0),  // 8px font-size` - shot-label font-size uses the px() helper

### Acceptance Criteria Met

- ✅ Shot-label font-size is scaled: `fs = px(8.0)` at line 397
- ✅ Shot labels appear at ~8px regardless of survey size
- ✅ No regression in other label sizes (CSS classes also scaled)
- ✅ Labels remain readable at extreme survey sizes

### Tests

- All 80 Rust tests pass
- TypeScript type check passes

No additional changes required - task is already implemented.
## Evidence
- Commits:
- Tests: 80 Rust tests pass, TypeScript type check passes
- PRs: