# Task 19: Add MergeProjects command to backend

## Overview
Create a new backend command to combine two projects into a new merged project. Handle section ID conflicts and preserve all data from both sources.

## Priority
Medium - Phase 5 (Project Merge)

## Risk Level
High

## Dependencies
None - can start immediately (blocking for Task 20, 21)

## Files to Modify
- `src-tauri/src/core/command.rs` - Add MergeProjects command
- `src-tauri/src/models/project.rs` - Merge logic implementation

## Specifications

### Merge Mode
- Append only: sections from source added to target
- No intelligent merging of overlapping data in v1

### ID Conflict Resolution
- Auto-renumber: Target project sections get new IDs
- Keep source IDs, renumber target to avoid conflicts
- Or: all sections get new unique IDs

### Zero Datums
- Keep all zero datums from both projects
- No deduplication in v1

### Merge Output
- Always create NEW file
- Original files remain unchanged
- User specifies output path

### Source File Handling
- Archive original files to subfolder after merge
- Subfolder: `.merged/` in project directory
- Or move to trash/recycle bin

### Undo Support
- Keep archived backup for recovery
- Undo restores original files

### Command Structure
```rust
pub enum Command {
    // ... existing commands
    MergeProjects {
        source_path: PathBuf,
        target_path: PathBuf,
        output_path: PathBuf,
    },
}
```

### Return Type
- Return path to merged project file
- On error, return descriptive error

## Acceptance Criteria
- [ ] MergeProjects command added to Command enum
- [ ] Merge combines all sections from both projects
- [ ] ID conflicts resolved (renumbered)
- [ ] All zero datums preserved
- [ ] New file created (originals unchanged)
- [ ] Original files archived
- [ ] Descriptive errors on failure
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Rust tests pass (`cargo test`)

## Test Requirements

### Rust Tests
- Test merge two projects with no conflicts
- Test merge with ID conflicts
- Test merge preserves all sections
- Test merge preserves all zero datums
- Test output file created correctly
- Test original files archived
- Test error handling for invalid paths

## Edge Cases
- Merge project with itself
- One project empty
- Both projects empty
- Projects with same section names
- Very large projects
- Invalid file paths
- Disk full during merge

## Implementation Notes
- High risk: complex operation with file I/O
- Consider transaction-like behavior (all or nothing)
- Archive files before merge, restore on failure
- Test thoroughly with various project sizes
