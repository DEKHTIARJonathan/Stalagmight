# fn-17-ygu.3 Add visual regression tests for export

## Description

Add regression tests to prevent future scaling bugs in SVG/PNG export.

**Size:** M
**Files:**
- `src-tauri/src/export/image.rs` (Rust unit tests)
- `e2e/specs/export-scaling.spec.ts` (WebdriverIO - new file)

## Approach

**Playwright tests cannot test real exports** (Tauri IPC is mocked). Use two approaches:

1. **Rust unit tests** in `image.rs`:
   - Create test survey with known dimensions (e.g., 100m x 50m)
   - Generate SVG string
   - Parse SVG and verify element attributes
   - Assert: `circle_r * scale ≈ 3.0`, `stroke-width * scale ≈ 2.0`, etc.
   - Tolerance: ±0.1px

2. **WebdriverIO tests** in `e2e/specs/`:
   - Follow pattern in `e2e/specs/export-integration.spec.ts`
   - Export SVG/PNG to temp file
   - Read file, parse SVG or measure PNG dimensions
   - Verify scaling at multiple DPI values (72, 150, 300, 600)

## Key context

- WebdriverIO tests run with real Tauri backend
- Existing `export-integration.spec.ts` already exports files to disk
- Rust tests can use regex or quick XML parsing to extract attributes
- fn-17-ygu.1 implemented the px() scaling helper (line 263) and applied it to all elements
- Basic DPI tests (72, 150, 300, 600) already added to image.rs but without detailed attribute verification

## Acceptance

- [ ] Rust unit tests verify SVG element sizes: `r * scale ≈ expected_px` (±0.1px tolerance)
- [ ] Rust tests cover: station (r), shot (.shot stroke-width), grid stroke-width, dasharray
- [ ] WebdriverIO tests verify PNG dimensions at DPI 72, 150, 300, 600
- [ ] WebdriverIO tests parse exported SVG and verify `r`, `stroke-width` attributes
- [ ] Tests catch the original 3-4x scaling bug if reverted

## Done summary
# fn-17-ygu.3: Add visual regression tests for export

## Summary

Added comprehensive visual regression tests for SVG/PNG export scaling to prevent future scaling bugs like the original 3-4x sizing issue.

## Changes

### Rust Unit Tests (`src-tauri/src/export/image.rs`)

Added 10 new regression tests:

1. **test_scaling_regression_station_radius** - Verifies station circles have 3px radius (±0.1px tolerance)
2. **test_scaling_regression_shot_stroke_width** - Verifies shot lines have 2px stroke-width
3. **test_scaling_regression_grid_stroke_width** - Verifies grid lines have 0.5px stroke-width
4. **test_scaling_regression_virtual_shot_dasharray** - Verifies virtual shot dash pattern (4px,2px)
5. **test_scaling_regression_label_font_size** - Verifies label font-size is 10px
6. **test_scaling_regression_section_name_font_size** - Verifies section name font-size is 12px
7. **test_scaling_consistent_across_different_survey_sizes** - Verifies pixel sizes stay consistent for survey extents 10m, 50m, 100m, 500m, 1000m
8. **test_scaling_zero_datum_larger_radius** - Verifies zero-datum stations have 6px radius
9. **test_png_dimensions_scale_with_dpi** - Verifies PNG output dimensions scale correctly at 72, 150, 300, 600 DPI

Added helper functions:
- `create_scaling_test_project()` - Creates test project with known dimensions
- `calculate_scale()` - Computes expected scale factor for validation

### WebdriverIO E2E Tests (`e2e/specs/export-scaling.spec.ts`)

Created new test file with 4 integration tests:

1. **should export PNG with correct dimensions at different DPI values** - Tests PNG dimensions at 72, 150, 300, 600 DPI
2. **should export SVG with properly scaled element attributes** - Verifies r, stroke-width attributes in exported SVG
3. **should maintain consistent pixel sizes for SVG elements regardless of survey data** - Tests that CSS values are scaled, not raw pixels
4. **should export SVG with station circles having correct attributes** - Verifies circle elements have r and inline fill

Helper functions added:
- `getPngDimensions()` - Reads PNG width/height from file header
- `extractSvgAttribute()` - Extracts numeric attribute values from SVG

## Test Coverage

The tests verify all acceptance criteria:
- ✅ Rust tests verify SVG element sizes: r * scale ≈ expected_px (±0.1px tolerance)
- ✅ Rust tests cover: station (r), shot (.shot stroke-width), grid stroke-width, dasharray
- ✅ WebdriverIO tests verify PNG dimensions at DPI 72, 150, 300, 600
- ✅ WebdriverIO tests parse exported SVG and verify r, stroke-width attributes
- ✅ Tests would catch the original 3-4x scaling bug if reverted
## Evidence
- Commits:
- Tests: rust, webdriverio
- PRs: