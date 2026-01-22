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

## Acceptance

- [ ] Rust unit tests verify SVG element sizes: `r * scale ≈ expected_px` (±0.1px tolerance)
- [ ] Rust tests cover: station (r), shot (.shot stroke-width), grid stroke-width, dasharray
- [ ] WebdriverIO tests verify PNG dimensions at DPI 72, 150, 300, 600
- [ ] WebdriverIO tests parse exported SVG and verify `r`, `stroke-width` attributes
- [ ] Tests catch the original 3-4x scaling bug if reverted

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
