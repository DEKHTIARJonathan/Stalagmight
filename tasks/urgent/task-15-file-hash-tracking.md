# Task 15: Implement DMP File Hash Tracking

## Description

Track imported DMP files by their SHA256 hash to warn users when importing a file that was already imported to the project.

## Files to Modify

- `src-tauri/src/models/project.rs`
- `src-tauri/src/persistence/sqlite.rs`
- `src-tauri/src/commands/import.rs`
- `src/store/projectStore.ts`

## Implementation

### 1. Add Hash Field to Project Model (Rust)

```rust
// In src-tauri/src/models/project.rs
pub struct Project {
    // ... existing fields
    pub imported_file_hashes: Vec<String>,
}
```

### 2. Database Schema Update

```sql
-- Add column to projects table
ALTER TABLE projects ADD COLUMN imported_file_hashes TEXT DEFAULT '[]';

-- Store as JSON array of hash strings
```

### 3. Calculate File Hash (Rust)

```rust
// In src-tauri/src/commands/import.rs
use sha2::{Sha256, Digest};
use std::fs;

#[tauri::command]
pub fn calculate_file_hash(path: &str) -> Result<String, String> {
    let contents = fs::read(path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let mut hasher = Sha256::new();
    hasher.update(&contents);
    let result = hasher.finalize();

    Ok(format!("{:x}", result))
}
```

### 4. Track Imported Hash

```rust
// In command executor, after successful import
pub fn track_imported_file(&mut self, hash: String) -> CommandResult {
    if let Some(ref mut project) = self.project {
        if !project.imported_file_hashes.contains(&hash) {
            project.imported_file_hashes.push(hash);
        }
    }
    Ok(())
}
```

### 5. Check for Duplicate Import

```rust
#[tauri::command]
pub fn check_duplicate_import(
    state: State<'_, AppState>,
    hash: String
) -> Result<bool, String> {
    let state = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref project) = state.project {
        Ok(project.imported_file_hashes.contains(&hash))
    } else {
        Ok(false)
    }
}
```

### 6. Frontend Integration

```tsx
// In projectStore.ts
calculateFileHash: async (path: string): Promise<string> => {
  return await invoke('calculate_file_hash', { path });
},

checkDuplicateImport: async (hash: string): Promise<boolean> => {
  return await invoke('check_duplicate_import', { hash });
},

trackImportedFile: async (hash: string): Promise<void> => {
  await invoke('track_imported_file', { hash });
},
```

### 7. Usage in Import Flow

```tsx
// Before opening Step 1 dialog
const hash = await calculateFileHash(filePath);
const isDuplicate = await checkDuplicateImport(hash);

if (isDuplicate) {
  const proceed = await showConfirmDialog({
    title: 'File Already Imported',
    message: 'This DMP file appears to have been imported before. Import again?',
    confirmText: 'Import Anyway',
  });
  if (!proceed) return;
}

// After successful import
await trackImportedFile(hash);
```

## Acceptance Criteria

- [ ] Project model has imported_file_hashes field
- [ ] Database schema updated with migration
- [ ] calculate_file_hash command returns SHA256
- [ ] check_duplicate_import detects duplicates
- [ ] track_imported_file stores hash after import
- [ ] Frontend calls check before import
- [ ] Warning dialog shown for duplicates
- [ ] TypeScript compiles without errors
- [ ] Rust tests pass

## Existing Tests to Modify

The following existing test files must be updated to account for changes made in this task:

### Playwright Tests
- `e2e-playwright/import-dialog.spec.ts` - Add tests for duplicate import warning
- `e2e-playwright/dmp-import.spec.ts` - Import flow tests need updating for hash tracking

### WebdriverIO Tests
- `e2e/specs/import-dmp-dialog.spec.ts` - Duplicate import warning tests need adding

### Mock Updates
- `e2e-playwright/mocks/tauri-ipc.ts` - Add mock handlers:
  - `calculate_file_hash` - returns mock hash string
  - `check_duplicate_import` - returns boolean
  - `track_imported_file` - returns null/void

## Test Suggestions

### Unit Tests (Rust)
1. Test calculate_file_hash returns consistent hash
2. Test check_duplicate_import returns false for new file
3. Test check_duplicate_import returns true after tracking
4. Test track_imported_file adds hash to project
5. Test track_imported_file doesn't duplicate existing hash
6. Test database persistence of hashes

### Playwright Tests (3-10)
1. Test duplicate warning shown for same file (mock)
2. Test no warning for new file
3. Test "Import Anyway" proceeds with import
4. Test cancel on duplicate warning aborts import

### WebdriverIO Tests (3-10)
1. Test importing same DMP file twice shows warning
2. Test hash persists after save and reload
3. Test different files don't trigger warning

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
