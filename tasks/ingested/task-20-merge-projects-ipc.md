# Task 20: Add merge_projects IPC handler

## Overview
Create a Tauri IPC command handler for the MergeProjects command, allowing the frontend to initiate project merges.

## Priority
Medium - Phase 5 (Project Merge)

## Risk Level
Medium

## Dependencies
- Task 19: MergeProjects command (must exist first)

## Files to Modify
- `src-tauri/src/commands/project.rs` - Add merge_projects handler
- `src-tauri/src/lib.rs` - Register command if needed

## Specifications

### IPC Command Signature
```rust
#[tauri::command]
async fn merge_projects(
    source_path: String,
    target_path: String,
    output_path: String,
    state: State<'_, AppState>,
) -> Result<String, String>
```

### Return Value
- Success: path to merged project (String)
- Error: descriptive error message

### Progress Indication
- Spinner only (no progress bar)
- Frontend shows loading state during merge

### Error Handling
- Return user-friendly error messages
- Include details about what failed

### Validation
- Validate file paths before merge
- Check files exist and are readable
- Check output path is writable

## Acceptance Criteria
- [ ] merge_projects IPC command registered
- [ ] Frontend can call merge_projects
- [ ] Returns path on success
- [ ] Returns error message on failure
- [ ] Path validation before merge
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Rust tests pass (`cargo test`)
- [ ] Playwright tests can call mock

## Test Requirements

### Rust Tests
- Test IPC handler calls command correctly
- Test error propagation
- Test path validation

### Playwright Tests (with mock)
- Test calling merge_projects from frontend
- Test success response handling
- Test error response handling

## Edge Cases
- Source file doesn't exist
- Target file doesn't exist
- Output path not writable
- Merge fails midway
- Paths with special characters

## Implementation Notes
- Standard Tauri command pattern
- Follows existing project.rs commands
- Update mocks in e2e-playwright for testing
