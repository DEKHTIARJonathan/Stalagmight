# fn-32-el3.1 Add map display Playwright tests

## Description
Add comprehensive Playwright E2E tests for map display features including scale bar, section labels, station labels, grid overlay, and satellite imagery toggle.

## Acceptance
- [x] Scale bar tests
- [x] Section label tests
- [x] Station label tests
- [x] Grid overlay tests
- [x] Satellite toggle tests
- [x] pnpm test:ui passes

## Done summary
# Task fn-32-el3.1 Summary

## Map Display Playwright Tests

The map display Playwright tests were already implemented in `e2e-playwright/ui-components.spec.ts` 
under the "Display Menu" test describe block (lines 195-406).

### Tests Verified

| Feature | Test Name | Status |
|---------|-----------|--------|
| Scale bar | should toggle scale bar visibility | PASS |
| Scale bar | should have scale bar in bottom-left position | PASS |
| Section names | should toggle section names visibility | PASS |
| Station labels | should toggle station labels visibility | PASS |
| Grid overlay | should toggle grid overlay visibility | PASS |
| Grid spacing | should change grid spacing | PASS |
| Satellite | should toggle satellite imagery visibility | PASS |
| Satellite | should show satellite option in Display menu | PASS |
| Satellite | should persist satellite toggle state during session | PASS |

### All Acceptance Criteria Met

- [x] Scale bar tests
- [x] Section label tests
- [x] Station label tests
- [x] Grid overlay tests
- [x] Satellite toggle tests
- [x] pnpm test:ui passes (190/190 tests pass)
## Evidence
- Commits:
- Tests: playwright, rust, typescript
- PRs: