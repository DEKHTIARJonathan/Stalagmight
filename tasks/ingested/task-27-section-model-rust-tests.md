# Task 27: Add Rust unit tests for Section model

## Overview
Add comprehensive unit tests for the Section model, covering station calculations and offset logic.

## Priority
High - Phase 7 (Testing & Quality)

## Risk Level
Low

## Dependencies
- After Task 15 (direction field) implemented

## Files to Modify
- `src-tauri/src/models/section.rs` - Add test module

## Specifications

### Test Coverage
- Full coverage of station calculations
- Offset logic tests
- Direction field tests (from Task 15)

### Test Areas

#### Station Calculations
- Test station positions from shots
- Test azimuth conversion
- Test depth calculation
- Test LRUD at stations

#### Offset Logic
- Test section offset application
- Test merged section offsets
- Test offset persistence

#### Direction Field
- Test IN direction
- Test OUT direction
- Test direction affects calculations (if applicable)
- Test direction persistence

### Test Structure
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_station_position_from_shots() { }

    #[test]
    fn test_section_offset_applied() { }

    #[test]
    fn test_direction_default_in() { }

    // ... more tests
}
```

## Acceptance Criteria
- [ ] Station calculation tests pass
- [ ] Offset logic tests pass
- [ ] Direction field tests pass
- [ ] All tests in `cargo test` suite
- [ ] Edge cases covered
- [ ] Math verified correct

## Test Requirements

### Specific Tests to Write
- `test_station_position_calculation`
- `test_station_from_azimuth_length`
- `test_station_depth_accumulation`
- `test_section_offset_applied`
- `test_merged_sections_offset`
- `test_direction_default`
- `test_direction_in`
- `test_direction_out`
- `test_lrud_at_stations`

## Edge Cases
- Single shot section
- Section with no shots
- Vertical shots (90° pitch)
- Shots crossing north (0°/360°)
- Very long sections
- Negative depths

## Implementation Notes
- Verify math against known survey data
- Use fixed test data for reproducibility
- Consider floating point precision
- Include direction field tests
- Low risk: testing existing code
