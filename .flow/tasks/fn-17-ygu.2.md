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
TBD

## Evidence
- Commits:
- Tests:
- PRs:
