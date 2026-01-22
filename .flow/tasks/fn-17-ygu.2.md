# fn-17-ygu.2 Fix shot-label font-size scaling

## Description

Fix the shot-label font-size to scale correctly like all other elements. Currently it's hardcoded as `font-size="8"` which is interpreted as viewBox units (meters), making it ~3-4x too large.

**Size:** S
**Files:**
- `src-tauri/src/export/image.rs` (line 375)

## Approach

Apply the same `value_world = value_px / scale` formula used for other elements:

```rust
// Current (broken) - hardcoded 8 in viewBox units
font-size="8"

// Fixed - scale the font size
let shot_label_font_size = 8.0 / scale;
format!(r##"... font-size="{:.2}" ..."##, shot_label_font_size)
```

The scale factor is already available from line 254.

## Key context

- CSS `font-size` in SVG without a unit is interpreted as viewBox units
- All other lengths are being scaled by `1/scale` to achieve constant pixel size
- Font sizes must follow the same pattern for consistency

## Acceptance

- [ ] Shot-label font-size is scaled: `font_size = 8.0 / scale`
- [ ] Shot labels appear at ~8px regardless of survey size
- [ ] No regression in other label sizes
- [ ] Labels remain readable at extreme survey sizes (10m to 10km)

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
