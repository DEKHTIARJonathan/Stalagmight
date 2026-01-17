# fn-13-hc2.1 Create GPS parsing utilities

## Description
## Overview
Create gps.ts with parsers for all 7 formats.
## Files
- src/utils/gps.ts (new)
## Acceptance
- [ ] DD parser
- [ ] DMS parser
- [ ] DDM parser
- [ ] UTM parser
- [ ] MGRS parser
- [ ] Plus Codes parser
- [ ] What3words parser
- [ ] URL extraction
- [ ] Tests pass
## Done summary
## Summary
Created GPS parsing utilities with support for all 7 coordinate formats plus URL extraction. The implementation includes:

- **DD (Decimal Degrees)**: Full parsing with validation
- **DMS (Degrees Minutes Seconds)**: Supports symbols, space-separated, and signed degrees
- **DDM (Degrees Decimal Minutes)**: Requires direction letters for disambiguation
- **UTM**: Full conversion to lat/lon using WGS84 ellipsoid
- **MGRS**: Format validation only (library required for conversion per spec)
- **Plus Codes**: Full OLC algorithm implementation
- **What3words**: Format validation only (API required per spec)
- **URL extraction**: Google Maps, OpenStreetMap, Bing Maps

Fixed signed DMS parsing to properly handle negative lat/lon combinations.

## Tests
All 66 GPS tests pass including:
- Format-specific parsing tests
- Coordinate validation tests
- URL extraction tests
- Signed DMS edge cases
- Error handling tests

## Files Changed
- src/utils/gps.ts (new) - GPS parsing utilities
- src/utils/gps.test.ts (new) - Comprehensive test suite
## Evidence
- Commits: 5cb984a fix(gps): require explicit direction for DMS parsing and remove unused mgrsToUtm, 0b1a709 fix(gps): fix signed DMS parsing and add tests for edge cases
- Tests: unit, e2e
- PRs: