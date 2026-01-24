# fn-17-ygu.1 Fix element size scaling in SVG export

## Description

Fix the SVG export so that all element sizes match expected pixel values. Currently elements appear ~3-4x larger because sizes are specified in viewBox units (meters) instead of being scaled to pixels.

**Size:** M
**Files:**
- `src-tauri/src/export/image.rs`

## Approach

For every SVG length that should be pixel-stable, apply: `value_world = value_px / scale`

The scale factor is at line 254: `scale = TARGET_SIZE / width.max(height)` where width/height already include padding.

**Elements to scale (ALL of these):**

| Element | Location | Current | Target px | Fix |
|---------|----------|---------|-----------|-----|
| Station radius | line 393 `r` attr | 4.0/6.0 | 3/6 | `r = 3.0 / scale` |
| Station stroke-width | line 393 | 1 | 1 | `stroke_width = 1.0 / scale` |
| Shot stroke-width | CSS `.shot` line 265 | 2 | 2 | inject scaled value |
| Virtual shot dasharray | `stroke-dasharray` | 4,2 | 4,2 | `"{4.0/scale},{2.0/scale}"` |
| Grid stroke-width | line 458 | 0.5 | 0.5 | `stroke_width = 0.5 / scale` |
| Shot-label dx/dy | line 375 | dx=2 dy=-2 | 2/2 | `dx="{2.0/scale}"` etc. |
| ZD label dx/dy | line 439 | dx=8 dy=4 | 8/4 | `dx="{8.0/scale}"` etc. |
| Section-name dx/dy | line 463 | dx=5 dy=-5 | 5/5 | `dx="{5.0/scale}"` etc. |
| Legend font-size | line 583 | varies | 10-12 | scale proportionally |
| Legend bar width | legend section | 15% | ~16px min | scale proportionally |

**DPI semantics**: Do NOT use `vector-effect="non-scaling-stroke"`. Higher DPI should produce proportionally thicker lines (same physical size when printed).

## Key context

- Preview (`ExportPreview.tsx:149-163`) uses pixel sizes: `'circle-radius': 3`, `'line-width': 2`
- Export generates SVG with viewBox in world coordinates (meters)
- DPI scaling applies AFTER SVG generation during PNG rasterization
- All lengths must be in viewBox units for correct DPI behavior

## Acceptance

- [ ] Station circles: `r * scale ≈ 3px` (6px for zero datum)
- [ ] Station stroke-width: `stroke-width * scale ≈ 1px`
- [ ] Shot stroke-width: `stroke-width * scale ≈ 2px`
- [ ] Virtual shot dasharray: `dash * scale ≈ 4px`, `gap * scale ≈ 2px`
- [ ] Grid stroke-width: `stroke-width * scale ≈ 0.5px`
- [ ] Shot-label offsets: `dx * scale ≈ 2px`, `dy * scale ≈ 2px`
- [ ] ZD label offsets: `dx * scale ≈ 8px`, `dy * scale ≈ 4px`
- [ ] Section-name offsets: `dx * scale ≈ 5px`, `dy * scale ≈ 5px`
- [ ] Legend sizing scales correctly
- [ ] Higher DPI (150, 300, 600) produces proportionally larger pixel dimensions
- [ ] Existing Rust tests pass

## Done summary
Fixed SVG export element scaling by applying pixel-to-viewBox conversion to all sizes (stations, shots, labels, legend). Added color sanitization to prevent SVG injection from user-controlled colors.
## Evidence
- Commits: 402f170, 07a66e0
- Tests: cargo test --manifest-path src-tauri/Cargo.toml -- image::
- PRs: