# Task 16: Enrich ProjectMetadata with GPS info

## Overview
Add GPS center point and bounds to ProjectMetadata, derived from zero datums. This enables positioning projects on the GlobalView map.

## Priority
Medium - Phase 4 (GlobalView Enhancements)

## Risk Level
Low

## Dependencies
None - can start immediately (needed for Task 17, 18)

## Files to Modify
- `src-tauri/src/models/project.rs` - Add GPS fields to ProjectMetadata
- `src-tauri/src/persistence/sqlite.rs` - Update metadata queries

## Specifications

### GPS Fields to Add
```rust
pub struct ProjectMetadata {
    // ... existing fields
    pub gps_center: Option<(f64, f64)>,  // (lat, lon) from first zero datum
    pub gps_bounds: Option<GpsBounds>,    // bounding box
}

pub struct GpsBounds {
    pub north: f64,
    pub south: f64,
    pub east: f64,
    pub west: f64,
}
```

### Center Calculation
- Use first zero datum's coordinates
- If no zero datums, gps_center is None

### Bounds Calculation
- Include all zero datums in bounds
- Expand to include all stations if GPS-positioned
- None if no GPS data

### No GPS Handling
- Projects without GPS: gps_center and gps_bounds are None
- Skip in GlobalView map list (but show in card/list view)

### Database Storage
- Store in project metadata or calculate on load
- Consider caching for performance

## Acceptance Criteria
- [ ] gps_center field added to ProjectMetadata
- [ ] gps_bounds field added to ProjectMetadata
- [ ] Center calculated from first zero datum
- [ ] Bounds include all zero datums
- [ ] None values for projects without GPS
- [ ] Data available in frontend
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Rust tests pass (`cargo test`)

## Test Requirements

### Rust Tests
- Test metadata with single zero datum
- Test metadata with multiple zero datums
- Test metadata with no zero datums
- Test bounds calculation
- Test center calculation

### Playwright Tests
- Test GPS data visible in project info (if displayed)

## Edge Cases
- Project with no zero datums
- Project with one zero datum
- Project with multiple zero datums
- Zero datum at poles or date line
- Very large project spanning many coordinates

## Implementation Notes
- Low risk: additive change to existing structure
- Calculate GPS info when loading project metadata
- May cache for performance with many projects
