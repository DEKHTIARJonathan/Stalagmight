# Task 15: Add direction field to Section model

## Overview
Add IN/OUT direction enum to the Section model, persist it to the database, and display it in the import dialog. This indicates the survey direction of each section.

## Priority
Medium - Phase 4 (GlobalView Enhancements)

## Risk Level
High (database schema change)

## Dependencies
None - can start immediately

## Files to Modify
- `src-tauri/src/models/section.rs` - Add direction field
- `src-tauri/src/persistence/sqlite.rs` - Update schema and queries
- `src/components/Dialogs/DmpImportDialog.tsx` - Display direction

## Specifications

### Direction Enum
```rust
pub enum SurveyDirection {
    In,   // Survey going into the cave
    Out,  // Survey coming out of the cave
}
```

### Default Value
- DMP files without direction data default to IN

### Editability
- Direction is editable by user
- Can change in import dialog
- Can change in section properties

### Display
- NOT shown in SectionsPanel (answer clarified this)
- Shown in Import Dialog
- Show in section details/properties view

### Database Schema
- Add `direction TEXT` column to sections table
- Values: "in" or "out"
- Nullable for backwards compatibility, default "in"

### Export Behavior
- Optional: include in export if supported by format
- Not critical for v1

### UI Requirements
- Dropdown or toggle in Import Dialog per section
- Add `data-testid` attributes:
  - `section-direction-{sectionId}`

## Acceptance Criteria
- [ ] Direction field added to Section model
- [ ] Database schema updated with migration
- [ ] DMP without direction defaults to IN
- [ ] Direction editable in Import Dialog
- [ ] Direction persisted to database
- [ ] Direction loaded correctly from database
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Rust tests pass (`cargo test`)
- [ ] Playwright tests pass

## Test Requirements

### Rust Tests
- Test Section with direction field
- Test default direction is IN
- Test database persistence
- Test database loading

### Playwright Tests
- Test direction selector in Import Dialog
- Test direction changes persist
- Test default direction for DMP without data

## Edge Cases
- Old database without direction column (migration)
- DMP with explicit direction data
- Change direction after import
- Export with direction

## Implementation Notes
- High risk due to database schema change
- Need migration strategy for existing databases
- Consider using SQLite ALTER TABLE or versioned schema
