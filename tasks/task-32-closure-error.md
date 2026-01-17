# Task 32: Closure Error Calculation

## Overview
Calculate and store closure error percentage when loops are detected. Display both percentage of path length and absolute distance in meters.

## Priority
High - Phase A (Loop Closure)

## Risk Level
Low-Medium

## Dependencies
- Task 31: Loop detection algorithm

## Files to Modify
- `src-tauri/src/models/project.rs` - Error calculation logic
- `src-tauri/src/persistence/sqlite.rs` - Persist loop closure data
- `src/components/SingleSystemView/DetailPanel.tsx` - Display closure stats

## Specifications

### Error Calculation
```rust
// Horizontal misclosure
let dx = station_a.x - station_b.x;
let dy = station_a.y - station_b.y;
let horizontal_misclosure = (dx * dx + dy * dy).sqrt();

// 3D misclosure (including depth)
let dz = station_a.depth - station_b.depth;
let misclosure_3d = (dx * dx + dy * dy + dz * dz).sqrt();

// Error percentage
let error_percentage = (misclosure_distance / path_length) * 100.0;
```

### Display Format
- Show BOTH metrics:
  - Percentage: "3.2% closure error"
  - Absolute: "0.45m misclosure"
- Display in statistics panel only (not on map)
- Configurable threshold for "acceptable" error (settings)

### Storage
- Store with merge in loop_closures table
- Recalculate if shots in loop path are edited

### Error Threshold
- Configurable in settings (default: 5%)
- Visual indicator: green (<threshold), yellow (threshold-2x), red (>2x)

## Acceptance Criteria
- [ ] Error calculated correctly for all loops
- [ ] Both % and meters displayed in statistics
- [ ] Data persisted to loop_closures table
- [ ] Recalculates when loop shots edited
- [ ] Threshold configurable in settings
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Rust Tests
1. Test error calculation with known geometry (equilateral triangle = 0%)
2. Test 3D error calculation with depth changes
3. Test horizontal-only misclosure calculation
4. Test persistence to loop_closures table
5. Test retrieval of stored closure data
6. Test recalculation triggers when loop shot edited
7. Test error percentage formula (misclosure / path_length * 100)

### Playwright Tests (Mocked IPC)
1. Test error percentage displays in statistics panel
2. Test absolute meters displays alongside percentage
3. Test threshold color coding (green/yellow/red)
4. Test both metrics shown together

### WebdriverIO Tests (Full App)
1. Test closure error calculated correctly with real survey data
2. Test error persists to database and reloads
3. Test editing shot in loop triggers recalculation
4. Test threshold colors match configured settings

## Edge Cases
- Zero-length path (shouldn't happen)
- Very small errors (< 0.01%)
- Very large errors (> 100%)
