# Fix SVG/PNG Export Element Scaling

## Overview

When exporting survey maps to SVG or PNG format, all elements (shots, stations, labels) appear approximately 3-4x larger than on screen. The preview modal shows correct sizing, but exported files have oversized elements while canvas dimensions are correct.

## Root Cause

In `src-tauri/src/export/image.rs`, SVG element sizes (station radius, stroke-width) are specified in **viewBox units (meters)** instead of being scaled to **display pixels**.

Example for a 200m survey:
- viewBox: `0 0 240 140` (meters + padding)
- Canvas: 800x571 pixels (scaled to TARGET_SIZE=800)
- Scale: 800/240 = 3.33 px/meter

**Current behavior (broken):**
- Station `r="4"` = 4 meters = 13.3 pixels
- Shot `stroke-width: 2` = 2 meters = 6.7 pixels

**Expected behavior:**
- Station radius: ~4 pixels (screen size)
- Shot stroke: ~2 pixels (screen size)

## Scope

**In scope (bugfix):**
- Fix element scaling by dividing sizes by scale factor
- Fix shot-label font-size missing px unit
- Ensure legend sizing is correct
- Add visual regression tests
- Update documentation

**Out of scope (defer to future epics):**
- Viewport vs entire survey choice (new feature)
- User-selectable background color (new feature)
- Print-friendly color option (new feature)
- Scale bar / north arrow (new feature)
- LRUD cross-section rendering (not implemented)
- Progress indicator for large exports (enhancement)
- Export settings persistence (enhancement)

## Approach

### Fix Strategy

1. **Calculate desired pixel sizes** for each element type
2. **Divide by scale factor** to convert to viewBox units:
   ```rust
   let station_radius_px = 4.0;  // desired pixels
   let station_radius_world = station_radius_px / scale;  // viewBox units
   ```

3. **Alternative for strokes**: Use `vector-effect="non-scaling-stroke"` CSS property to make stroke-width independent of viewBox scaling

4. **Fix font-size units**: Ensure all font-size attributes have `px` suffix

### Files to Modify

| File | Change |
|------|--------|
| `src-tauri/src/export/image.rs:265-268` | CSS styles - add vector-effect or scale stroke-width |
| `src-tauri/src/export/image.rs:355-356` | Shot line stroke - scale by inverse |
| `src-tauri/src/export/image.rs:393-394` | Station radius - scale by inverse |
| `src-tauri/src/export/image.rs:375` | Shot-label font-size - add px unit |
| `src-tauri/src/export/image.rs:581-583` | Legend font-size - verify correct |

### Element Size Mapping

| Element | Current | Unit | Fix To | Target Pixels |
|---------|---------|------|--------|---------------|
| Station radius | 4.0 / 6.0 | meters | `4.0/scale` | 4px / 6px |
| Shot stroke-width | 2 | meters | `2.0/scale` or non-scaling | 2px |
| Grid stroke-width | 0.5 | meters | `0.5/scale` | 0.5px |
| Shot-label font-size | 8 | implicit | 8px (add unit) | 8px |
| Label font-size | 10px | pixels | unchanged | 10px |
| Section-name font-size | 12px | pixels | unchanged | 12px |

## Edge Cases

- **Very large surveys (>1km)**: Elements may become sub-pixel. Add minimum size clamp.
- **Very small surveys (<10m)**: Elements remain readable with 10% padding.
- **Zero datum station**: Larger radius (6px vs 4px) scales proportionally.

## Quick commands
```bash
# Run Rust tests
cargo test --manifest-path src-tauri/Cargo.toml

# Run Playwright tests (includes export tests)
pnpm test:ui

# Type check
pnpm tsc --noEmit
```

## Acceptance

- [ ] Exported SVG/PNG elements match screen display (< 1% visual diff)
- [ ] Station circles are ~4px radius (6px for zero datum)
- [ ] Shot lines are ~2px stroke width
- [ ] Labels are readable at correct size
- [ ] Shot-label font-size has px unit
- [ ] Grid lines are appropriately thin (~0.5px)
- [ ] Legend sizing is correct when shown
- [ ] Works at all DPI settings (72, 96, 150, 300)
- [ ] Visual regression tests added
- [ ] Documentation updated (SPEC.md section 17.3)

## References

- `src-tauri/src/export/image.rs` - Main export logic
- `src/components/Dialogs/ExportPreview.tsx` - Preview (reference for correct pixel sizes)
- `docs/SPEC.md` section 17.3 - Export format specification
