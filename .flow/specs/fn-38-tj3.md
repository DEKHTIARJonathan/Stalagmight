# Rust Tests: Validation System

## Overview
| Field | Value |
|-------|-------|
| **Epic ID** | fn-38-tj3 |
| **Category** | Rust Unit Tests |
| **Target File** | `src-tauri/src/core/validation.rs` |
| **Tests** | 5 |
| **Priority** | P2 - Medium |
| **Source** | `tasks/task-05-validation-tests.md` |

## Objective
Implement unit tests for the validation system. These tests validate input validation for shots, sections, GPS coordinates, and other user input.

## Test Specifications

### Test 5.1: `test_validate_shot_length`
Verify shot length validation (must be positive, reasonable max).

### Test 5.2: `test_validate_azimuth_range`
Verify azimuth validation (0-360 degrees).

### Test 5.3: `test_validate_lrud_values`
Verify LRUD validation (non-negative values).

### Test 5.4: `test_validate_gps_coordinates`
Verify GPS coordinate validation (latitude -90 to 90, longitude -180 to 180).

### Test 5.5: `test_validate_backsight_tolerance`
Verify backsight azimuth tolerance (within configurable degrees of expected).

## Edge Cases
- Zero length shots
- Negative LRUD values
- Azimuth > 360 or < 0
- GPS coordinates at poles and date line
- Large backsight deviation

## Verification
```bash
cd src-tauri && cargo test core::validation::tests -- --nocapture
```

## Definition of Done
- [ ] All 5 tests implemented
- [ ] Validation error messages are helpful
- [ ] Edge cases covered
- [ ] Tests pass locally
