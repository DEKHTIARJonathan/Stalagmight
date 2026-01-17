# fn-38-tj3.1 Implement 5 validation tests

## Description
Implement unit tests for the validation system in `src-tauri/src/core/validation.rs`. These tests validate input validation for shots, sections, GPS coordinates, and other user input.

## Acceptance
- [x] test_validate_shot_length - Verify shot length validation (positive, reasonable max)
- [x] test_validate_azimuth_range - Verify azimuth validation (0-360 degrees)
- [x] test_validate_lrud_values - Verify LRUD validation (non-negative values)
- [x] test_validate_gps_coordinates - Verify GPS coordinate validation (latitude -90 to 90, longitude -180 to 180)
- [x] test_validate_backsight_tolerance - Verify backsight azimuth tolerance (within configurable degrees of expected)

## Done summary
Implemented 5 comprehensive validation tests in src-tauri/src/core/validation.rs:
1. test_validate_shot_length - Tests positive/negative/zero length, short/long shot warnings
2. test_validate_azimuth_range - Tests valid azimuths 0-360, invalid out of range
3. test_validate_lrud_values - Tests valid/zero/None LRUD, negative values error
4. test_validate_gps_coordinates - Tests valid coords, poles, date line, invalid lat/lon/NaN
5. test_validate_backsight_tolerance - Tests perfect/within/exceeds tolerance, wraparound, configurable thresholds
## Evidence
- Commits:
- Tests:
- PRs: