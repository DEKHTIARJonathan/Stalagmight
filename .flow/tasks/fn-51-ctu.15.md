# fn-51-ctu.15 Implement File Hash Tracking

## Description
Track imported DMP files by SHA256 hash to warn users when importing duplicates.

## Files to Modify
- `src-tauri/src/models/project.rs`
- `src-tauri/src/persistence/sqlite.rs`
- `src-tauri/src/commands/import.rs`
- `src/store/projectStore.ts`

## New Commands
```rust
#[tauri::command]
pub fn calculate_file_hash(path: &str) -> Result<String, String>

#[tauri::command]
pub fn check_duplicate_import(state: State, hash: String) -> Result<bool, String>

#[tauri::command]
pub fn track_imported_file(hash: String) -> CommandResult
```

## Project Model Change
```rust
pub struct Project {
    // ...
    pub imported_file_hashes: Vec<String>,
}
```

## References
- `tasks/urgent/task-15-file-hash-tracking.md`
## Acceptance
- [ ] Project model has imported_file_hashes field
- [ ] Database schema updated with migration
- [ ] calculate_file_hash command returns SHA256
- [ ] check_duplicate_import detects duplicates
- [ ] track_imported_file stores hash after import
- [ ] Frontend calls check before import
- [ ] Warning dialog shown for duplicates
- [ ] TypeScript compiles without errors
- [ ] Rust tests pass
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
