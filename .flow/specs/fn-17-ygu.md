# Fix SVG/PNG Export Element Scaling

## Overview

When exporting survey maps to SVG or PNG format, all elements (shots, stations, labels) appear approximately 3-4x larger than expected. The preview modal renders correctly via MapLibre, but the backend SVG generator uses viewBox units (meters) instead of scaling to display pixels.

## Root Cause

In `src-tauri/src/export/image.rs`, SVG element sizes are specified in **viewBox units (meters)** instead of being scaled to **display pixels**.

Example for a 200m survey:
- viewBox: `0 0 240 140` (meters + padding)
- Canvas: 800x571 pixels (scaled to TARGET_SIZE=800)
- Scale: 800/240 = 3.33 px/meter

## Scope

**In scope (bugfix):**
- Fix all element scaling in SVG export
- Ensure DPI produces proportionally larger pixels
- Add regression tests (Rust unit tests + WebdriverIO)
- Update documentation

**Out of scope (defer):**
- True visual parity with MapLibre preview (different renderers)
- New export features (viewport choice, background color, etc.)

## Approach

### Fix Strategy

For every SVG length that should be pixel-stable, use: `value_world = value_px / scale`

**DPI semantics**: Higher DPI = proportionally thicker lines (same physical size). Do NOT use `vector-effect="non-scaling-stroke"` as it would break DPI scaling.

### Elements to Scale

| Element | CSS/Attr | Current | Target Pixels | Fix |
|---------|----------|---------|---------------|-----|
| Station radius | `r` attr | 4.0/6.0 | 3/6 (match preview) | `r = target_px / scale` |
| Station stroke-width | `stroke-width` | 1 | 1 | `stroke_width = 1.0 / scale` |
| Shot stroke-width | CSS `.shot` | 2 | 2 | `stroke_width = 2.0 / scale` |
| Virtual shot dasharray | `stroke-dasharray` | 4,2 | 4,2 | `dash = 4.0/scale, gap = 2.0/scale` |
| Grid stroke-width | `stroke-width` | 0.5 | 0.5 | `stroke_width = 0.5 / scale` |
| Shot-label font-size | `font-size` attr | 8 (no unit) | 8px | Add `px` suffix |
| Label dx/dy offsets | `dx`, `dy` | 6, -6 | 6, -6 | `offset = 6.0 / scale` |
| Legend font-size | `font-size` attr | varies | 10-12px | `font_size = 10.0 / scale` |
| Legend bar width | `width` attr | 15% of bounds | ~16px min | Scale proportionally |

### Files to Modify

- `src-tauri/src/export/image.rs` - Main SVG generation, all element sizing

## Quick commands
```bash
cargo test --manifest-path src-tauri/Cargo.toml
pnpm test:wdio
pnpm tsc --noEmit
```

## Acceptance

- [ ] Station circles are ~3px radius (6px for zero datum) when measured as `r * scale`
- [ ] Shot lines are ~2px stroke width when measured as `stroke-width * scale`
- [ ] Grid lines are ~0.5px stroke width when measured
- [ ] Virtual shot dashes scale correctly
- [ ] Label offsets (dx/dy) scale correctly
- [ ] Shot-label font-size has `px` unit suffix
- [ ] Legend sizing is consistent (~10-12px font, ~16px bar width minimum)
- [ ] Higher DPI exports (150, 300, 600) produce proportionally larger pixel dimensions
- [ ] Rust unit tests verify SVG element scaling
- [ ] WebdriverIO tests verify exported file dimensions
- [ ] Documentation updated (SPEC.md section 17.3)

## References

- `src-tauri/src/export/image.rs` - Main export logic
- `src/components/Dialogs/ExportPreview.tsx:149-163` - Preview pixel sizes (reference)
- `docs/SPEC.md` section 17.3 - Export format specification
