# fn-17-ygu.3 Add visual regression tests for export

## Description
Add visual regression tests to prevent future scaling bugs in SVG/PNG export.

**Size:** M
**Files:**
- `e2e-playwright/export-scaling.spec.ts` (new file)
- `e2e-playwright/fixtures/` (test survey fixtures)

## Approach

1. Create test fixture with known dimensions (~50m survey)
2. Test SVG export: verify element sizes are scaled correctly (r, stroke-width attributes)
3. Test PNG export: verify dimensions at 72, 96, 300 DPI
4. Optional: visual comparison between preview and export

## Key context

- Follow patterns in `e2e-playwright/export-dialog.spec.ts`
- Use regex or DOMParser to parse SVG attributes
- Tests should catch the 3-4x scaling bug if reverted
## Acceptance
- [ ] Test verifies SVG element sizes are scaled correctly
- [ ] Test verifies PNG dimensions at multiple DPI values
- [ ] Tests run in CI pipeline
- [ ] Tests catch the original 3-4x scaling bug if reverted
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
