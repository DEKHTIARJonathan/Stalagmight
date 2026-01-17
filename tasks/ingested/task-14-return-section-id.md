# Task 14: Return section ID from create_section command

## Overview
Modify the backend create_section command to return the created section ID in the CommandResult. This is needed for placement features to identify newly created sections.

## Priority
High - Phase 3 (GPS & Placement)

## Risk Level
Medium

## Dependencies
None - can start immediately (blocking for Tasks 12, 13)

## Files to Modify
- `src-tauri/src/commands/section.rs` - Modify return type
- `src-tauri/src/core/command.rs` - Update CommandResult if needed
- `src-tauri/src/core/state.rs` - Update command execution

## Specifications

### Return Data
- Return just the section ID (simple approach)
- ID should be the newly created section's unique identifier

### Batch Support
- If creating multiple sections, return all IDs
- Return as array: `[section_id_1, section_id_2, ...]`

### Return Type Design
- Use best design practices for Rust
- Consider existing CommandResult structure
- May use `CommandResult::SectionCreated { id: SectionId }` variant

### IPC Changes
- Frontend receives section ID in response
- TypeScript types updated to expect ID

## Acceptance Criteria
- [ ] create_section returns section ID
- [ ] Batch create returns all section IDs
- [ ] CommandResult updated appropriately
- [ ] Frontend can access returned ID
- [ ] TypeScript types updated
- [ ] Existing functionality not broken
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Rust tests pass (`cargo test`)

## Test Requirements

### Rust Tests
- Test single section creation returns ID
- Test batch section creation returns all IDs
- Test returned ID matches created section

### Playwright Tests
- Test frontend receives section ID
- Test ID can be used for subsequent operations

## Edge Cases
- Create section fails (no ID returned)
- Create empty section
- Create section with duplicate name
- Create many sections at once

## Implementation Notes
- Clean change to existing command pattern
- Consider backwards compatibility
- May need to update command.rs CommandResult enum
- Frontend TypeScript types need to match
