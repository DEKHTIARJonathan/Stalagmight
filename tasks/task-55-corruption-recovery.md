# Task 55: File Corruption Recovery

## Overview
Detect and recover from corrupted project files. Validate SQLite integrity on open and offer repair options with backup before repair.

## Priority
Medium - Phase G (Error Handling)

## Risk Level
Medium

## Dependencies
- Existing persistence layer

## Files to Modify
- `src-tauri/src/persistence/sqlite.rs` - Integrity checks
- `src-tauri/src/commands/project.rs` - Recovery commands
- `src/components/Dialogs/RecoveryDialog.tsx` - New dialog

## Specifications

### Integrity Check Levels
1. **Quick Check** (on open):
   - `PRAGMA quick_check`
   - Verify required tables exist
   - Check schema version

2. **Full Check** (on-demand):
   - `PRAGMA integrity_check`
   - Verify all foreign keys
   - Check data consistency

### Detection Points
- Project open
- After crash/force quit
- Manual trigger from menu

### Corruption Types
| Type | Detection | Recovery |
|------|-----------|----------|
| SQLite corruption | PRAGMA check fails | Recover from backup |
| Missing tables | Schema query fails | Recreate tables |
| Invalid data | Validation fails | Flag/remove bad records |
| Version mismatch | Schema version wrong | Migration or reject |

### Recovery Options
Always ask user before repair:
1. **Attempt Repair**: Try to fix in-place
2. **Restore Backup**: Use last known good backup
3. **Export Salvageable**: Export what can be read
4. **Discard**: Close without loading

### Backup Before Repair
```rust
fn backup_before_repair(path: &Path) -> Result<PathBuf> {
    let backup_path = path.with_extension("cvproj.backup");
    fs::copy(path, &backup_path)?;
    Ok(backup_path)
}
```

### Recovery Dialog
```tsx
<RecoveryDialog
  isOpen={showRecoveryDialog}
  corruptionType="sqlite_integrity"
  message="The project file appears to be corrupted."
  options={[
    { id: 'repair', label: 'Attempt Repair', description: '...' },
    { id: 'backup', label: 'Restore from Backup', description: '...' },
    { id: 'export', label: 'Export Salvageable Data', description: '...' },
    { id: 'discard', label: 'Cancel', description: '...' },
  ]}
  onSelect={handleRecoveryOption}
/>
```

### Logging
- Log all corruption detections
- Log recovery attempts and results
- Include in bug reporter data

## Acceptance Criteria
- [ ] Quick integrity check on open
- [ ] Full integrity check on-demand
- [ ] Recovery dialog with options
- [ ] Backup created before repair
- [ ] Repair attempts logged
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Rust Tests
1. Test quick_check detects SQLite corruption
2. Test quick_check verifies required tables
3. Test full integrity_check runs
4. Test backup file created before repair
5. Test repair attempt on corrupted file
6. Test schema version mismatch detected

### Playwright Tests (Mocked IPC)
1. Test recovery dialog appears for corrupt file
2. Test all four recovery options displayed
3. Test "Attempt Repair" option selectable
4. Test "Restore from Backup" option selectable
5. Test "Export Salvageable" option selectable
6. Test "Cancel" closes without loading

### WebdriverIO Tests (Full App)
1. Test corrupted file triggers recovery dialog
2. Test backup created before repair
3. Test repair restores functionality
4. Test export salvages readable data
5. Test corruption logged for debugging

## Edge Cases
- Backup file also corrupted
- Disk full during backup
- File locked by another process
- Very large corrupt file
