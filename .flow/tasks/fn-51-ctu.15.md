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
# Task fn-51-ctu.15: Implement File Hash Tracking

## Summary
Implemented DMP file hash tracking using SHA256 to warn users when importing files that have already been imported to the project.

## Changes Made

### Backend (Rust)
1. **Added `sha2` dependency** to Cargo.toml
2. **Updated Project model** (`src-tauri/src/models/project.rs`):
   - Added `imported_file_hashes: Vec<String>` field
   - Initialized in `Project::new()`
3. **Updated database schema** (`src-tauri/src/persistence/sqlite.rs`):
   - Added `imported_file_hashes` table
   - Save/load imported hashes with project data
   - Migration support for older project files
4. **Added Tauri commands** (`src-tauri/src/commands/import.rs`):
   - `calculate_file_hash(path)` - Returns SHA256 hash of file
   - `check_duplicate_import(hash)` - Checks if hash already imported
   - `track_imported_file(hash)` - Stores hash after successful import
5. **Added AppState methods** (`src-tauri/src/core/state.rs`):
   - `check_duplicate_import()` - Query project hashes
   - `track_imported_file()` - Add hash to project

### Frontend (TypeScript)
1. **Updated projectStore.ts**:
   - Added `calculateFileHash()`, `checkDuplicateImport()`, `trackImportedFile()` actions
2. **Updated Tauri IPC mocks** (`e2e-playwright/mocks/tauri-ipc.ts`):
   - Added mock handlers for all three new commands

## Test Results
- TypeScript: Compiles without errors
- Rust: All 161 unit tests pass
- Playwright: 112 tests pass, 1 skipped
## Evidence
- Commits:
- Tests:
- PRs: