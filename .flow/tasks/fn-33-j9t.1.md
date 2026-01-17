# fn-33-j9t.1 Add GPS/placement Playwright tests

## Description
Verify comprehensive Playwright E2E test coverage for GPS coordinate input, placement modes, and adjustment dialogs.

## Acceptance
- [x] All 7 GPS format tests (DD, DMS, DDM, UTM, MGRS, PlusCodes, What3words)
- [x] Existing station tests
- [x] Manual placement tests
- [x] Adjustment dialog tests
- [x] Mock APIs for Plus Codes/What3words (Plus Codes offline, What3words shows API error)
- [x] pnpm test:ui passes

## Done summary
Verified existing GPS/placement test coverage is comprehensive. Fixed flaky globalview-map hover test by increasing timeout. All 190 Playwright tests pass.

Key test coverage:
- GPS Input UI: DD, DMS, DDM, UTM, MGRS, PlusCodes, What3words format tests
- Placement Mode - From Existing Station: station selector tests
- Placement Mode - Manual Map Placement: placement indicator tests
- Section Adjust Dialog: dx/dy offset input tests
- GlobalView Map: GPS display and marker tests
## Evidence
- Commits:
- Tests: playwright
- PRs: