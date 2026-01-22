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

| Element | Target Pixels | Fix Formula |
|---------|---------------|-------------|
| Station radius | 3 (6 for ZD) | `r = 3.0 / scale` |
| Station stroke-width | 1 | `stroke_width = 1.0 / scale` |
| Shot stroke-width | 2 | `stroke_width = 2.0 / scale` |
| Virtual shot dasharray | 4,2 | `"{4.0/scale},{2.0/scale}"` |
| Grid stroke-width | 0.5 | `stroke_width = 0.5 / scale` |
| Shot-label font-size | 8 | `font_size = 8.0 / scale` |
| Shot-label dx/dy | 2/2 | `dx="{2.0/scale}" dy="{2.0/scale}"` |
| ZD label dx/dy | 8/4 | `dx="{8.0/scale}" dy="{4.0/scale}"` |
| Section-name dx/dy | 5/5 | `dx="{5.0/scale}" dy="{5.0/scale}"` |
| Legend font-size | 10-12 | scale proportionally |
| Legend bar width | ~16px min | scale proportionally |

### Files to Modify

- `src-tauri/src/export/image.rs` - Main SVG generation, all element sizing

## Quick commands
```bash
cargo test --manifest-path src-tauri/Cargo.toml
pnpm test:wdio
pnpm tsc --noEmit
```

## Acceptance

- [ ] Station circles: `r * scale ≈ 3px` (6px for zero datum)
- [ ] Shot lines: `stroke-width * scale ≈ 2px`
- [ ] Grid lines: `stroke-width * scale ≈ 0.5px`
- [ ] Virtual shot dashes scale correctly
- [ ] All label offsets (dx/dy) scale correctly
- [ ] All font-sizes scale correctly (not just px suffix)
- [ ] Legend sizing is consistent (~10-12px font, ~16px bar width minimum)
- [ ] Higher DPI exports (150, 300, 600) produce proportionally larger pixel dimensions
- [ ] Rust unit tests verify SVG element scaling
- [ ] WebdriverIO tests verify exported file dimensions
- [ ] Documentation updated (SPEC.md section 17.3)

## References

- `src-tauri/src/export/image.rs` - Main export logic
- `src/components/Dialogs/ExportPreview.tsx:149-163` - Preview pixel sizes (reference)
- `docs/SPEC.md` section 17.3 - Export format specification
