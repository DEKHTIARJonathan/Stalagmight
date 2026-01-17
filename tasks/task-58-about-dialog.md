# Task 58: About Dialog

## Overview
Create About dialog showing version, build date, credits, license, and copyable diagnostics. Accessible from Help menu.

## Priority
Low - Phase H (Polish)

## Risk Level
Low

## Dependencies
- Task 34: Settings dialog (for tab placement)

## Files to Modify
- `src/components/Dialogs/AboutDialog.tsx` - New file (or TabAbout.tsx in settings)
- `src/store/uiStore.ts` - About dialog state
- `src-tauri/src/commands/app.rs` - Get app info command

## Specifications

### Access
- Help > About CaveChef
- Also available as tab in Settings dialog (Task 34)

### Content Sections

#### Version Info
```
CaveChef v1.0.0
Build: 2024-01-15 (abc1234)
```

#### Credits
```
Developed by [Your Name/Team]
Using: Tauri, React, MapLibre GL JS
```

#### License
```
MIT License
Copyright (c) 2024
```

#### Diagnostics (Copyable)
```
Platform: linux x64
Tauri: 2.0.0
WebView: Chrome/120
Config path: ~/.config/cavechef/
Data path: ~/.local/share/cavechef/
Log path: ~/.local/share/cavechef/logs/
Memory: 256 MB used
```

### Copy Diagnostics
- "Copy Diagnostics" button
- Copies full diagnostics to clipboard
- Toast: "Diagnostics copied"

### No External Links
- No links to website
- No "Check for updates" button
- Keep it simple for v1

### Backend Command
```rust
#[tauri::command]
fn get_app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        build_date: build_time::build_time_local!(),
        commit: option_env!("GIT_HASH").unwrap_or("dev"),
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        config_path: config_dir(),
        data_path: data_dir(),
        log_path: log_dir(),
    }
}
```

### UI Layout
```
┌─────────────────────────────────┐
│           CaveChef              │
│            v1.0.0               │
│                                 │
│  Build: 2024-01-15 (abc1234)    │
│                                 │
│  ─────────────────────────────  │
│                                 │
│  Credits                        │
│  Developed by ...               │
│                                 │
│  ─────────────────────────────  │
│                                 │
│  Diagnostics            [Copy]  │
│  ┌───────────────────────────┐  │
│  │ Platform: linux x64       │  │
│  │ Tauri: 2.0.0              │  │
│  │ ...                       │  │
│  └───────────────────────────┘  │
│                                 │
│               [Close]           │
└─────────────────────────────────┘
```

## Acceptance Criteria
- [ ] About dialog accessible from menu
- [ ] Version info displayed
- [ ] Credits displayed
- [ ] Diagnostics displayed
- [ ] Copy diagnostics works
- [ ] No external links
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Rust Tests
1. Test get_app_info returns version
2. Test get_app_info returns build date
3. Test get_app_info returns platform
4. Test get_app_info returns config path
5. Test get_app_info returns log path

### Playwright Tests (Mocked IPC)
1. Test About dialog opens from Help menu
2. Test version number displayed
3. Test build date displayed
4. Test credits section visible
5. Test diagnostics section visible
6. Test "Copy Diagnostics" button works
7. Test no external links present
8. Test Close button works

### WebdriverIO Tests (Full App)
1. Test About shows correct version
2. Test About shows correct platform
3. Test Copy Diagnostics copies to clipboard
4. Test diagnostics contain all system info
5. Test About accessible from settings tab

## Edge Cases
- Build without git hash
- Very long paths in diagnostics
- Copy fails (clipboard unavailable)
