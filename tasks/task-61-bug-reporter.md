# Task 61: Bug Reporter

## Overview
Implement a guided bug reporting flow in the About dialog. Collects system info, recent errors, and user description, then exports to file or clipboard.

## Priority
Medium - Phase H (Polish)

## Risk Level
Medium

## Dependencies
- Task 58: About dialog (integration point)

## Files to Modify
- `src/components/Dialogs/BugReporter.tsx` - New component
- `src/components/Dialogs/AboutDialog.tsx` - Add reporter link
- `src-tauri/src/commands/app.rs` - Export logs command

## Specifications

### Access
- About dialog > "Report a Bug" button
- Help > Report Bug menu item

### Guided Flow Steps
1. **Describe Problem**
   - Text area for description
   - "What were you trying to do?"
   - "What happened instead?"

2. **Attach Info**
   - Checkboxes for what to include:
     - [ ] System information (always)
     - [ ] Recent error log
     - [ ] Current project state (optional)
     - [ ] Screenshots (manual attach)

3. **Review & Export**
   - Show preview of report
   - "Copy to Clipboard" button
   - "Save as File" button

### Report Format
```markdown
# CaveChef Bug Report
Generated: 2024-01-15 14:30:00

## Description
[User's description]

## System Information
- Version: 1.0.0
- Platform: linux x64
- Tauri: 2.0.0
- Memory: 256 MB

## Recent Errors
```
[Last 50 lines of error log]
```

## Steps to Reproduce
[If provided by user]
```

### Log Export
```rust
#[tauri::command]
fn export_recent_logs(lines: usize) -> Result<String> {
    let log_path = log_dir().join("cavechef.log");
    let content = fs::read_to_string(&log_path)?;
    let recent: Vec<&str> = content.lines().rev().take(lines).collect();
    Ok(recent.into_iter().rev().collect::<Vec<_>>().join("\n"))
}
```

### Privacy Considerations
- Warn about including project data
- Don't include full file paths
- Sanitize personal info from logs
- User reviews before export

### UI Layout
```
┌─────────────────────────────────────┐
│  Report a Bug                       │
│                                     │
│  Step 1 of 3: Describe the Problem  │
│                                     │
│  What happened?                     │
│  ┌─────────────────────────────┐    │
│  │                             │    │
│  │                             │    │
│  └─────────────────────────────┘    │
│                                     │
│  What did you expect?               │
│  ┌─────────────────────────────┐    │
│  │                             │    │
│  └─────────────────────────────┘    │
│                                     │
│        [Back]  [Next]               │
└─────────────────────────────────────┘
```

### Export Options
- Copy to clipboard: For pasting into GitHub issue
- Save as file: `bug-report-2024-01-15.md`
- No direct submission (no server)

## Acceptance Criteria
- [ ] Guided flow works
- [ ] System info collected
- [ ] Logs can be included
- [ ] Privacy warning shown
- [ ] Copy to clipboard works
- [ ] Save to file works
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Rust Tests
1. Test export_recent_logs returns last N lines
2. Test export_recent_logs handles missing log file
3. Test export_recent_logs handles empty log
4. Test export_recent_logs limits output size

### Playwright Tests (Mocked IPC)
1. Test bug reporter opens from About dialog
2. Test bug reporter opens from Help menu
3. Test Step 1 (description) shows text areas
4. Test Step 2 (attachments) shows checkboxes
5. Test Step 3 (review) shows preview
6. Test Back/Next navigation works
7. Test "Copy to Clipboard" copies report
8. Test "Save as File" triggers download
9. Test privacy warning shown for project data

### WebdriverIO Tests (Full App)
1. Test full bug report flow
2. Test system info included in report
3. Test logs included when checkbox selected
4. Test report file saved correctly
5. Test clipboard contains report content

## Edge Cases
- No error log exists
- Very large log file
- Clipboard unavailable
- Special characters in description
