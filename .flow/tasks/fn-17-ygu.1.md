# fn-17-ygu.1 Fix element size scaling in SVG export

## Description
Fix the SVG export so that element sizes (station radius, shot stroke-width, grid stroke-width) match the screen display. Currently elements appear ~3-4x larger because sizes are specified in viewBox units (meters) instead of being scaled to pixels.

**Size:** M
**Files:**
- `src-tauri/src/export/image.rs` (lines 265-268, 355-356, 393-394, 458-459)

## Approach

The scale factor is already calculated at line 252-257. For each element type, divide the desired pixel size by scale to get viewBox units:

1. **Station radius** (line 393): Divide desired px (4.0/6.0) by scale
2. **Shot stroke-width** (CSS line 265): Use `vector-effect="non-scaling-stroke"` or calculate `2.0/scale`
3. **Grid stroke-width** (line 458-459): Calculate `0.5/scale`
4. **Add minimum size clamp** to prevent sub-pixel elements at large surveys

## Key context

- Preview uses MapLibre with pixel-based sizes: `'circle-radius': 3`, `'line-width': 2`
- Export generates SVG with viewBox in world coordinates (meters)
- DPI scaling happens AFTER SVG generation (in PNG rasterization)
## Acceptance
- [ ] Station circles are ~4px radius (6px for zero datum)
- [ ] Shot lines are ~2px stroke width
- [ ] Grid lines are ~0.5px stroke width
- [ ] Elements scale correctly at all survey sizes (10m to 10km)
- [ ] Minimum size prevents invisible elements at large surveys
- [ ] Existing Rust tests pass
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
