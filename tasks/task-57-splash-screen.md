# Task 57: Splash Screen

## Overview
Display a loading screen during Tauri application initialization. Shows logo and status text until the app is ready.

## Priority
Medium - Phase H (Polish)

## Risk Level
Medium

## Dependencies
- None

## Files to Modify
- `src-tauri/tauri.conf.json` - Splash configuration
- `src-tauri/src/main.rs` - Splash lifecycle
- `splash.html` - New splash screen page (if custom)

## Specifications

### Tauri Native Splash
Use Tauri's built-in splash screen capability:
```json
// tauri.conf.json
{
  "build": {
    "beforeBuildCommand": "pnpm build"
  },
  "bundle": {
    "active": true
  },
  "app": {
    "windows": [{
      "title": "CaveChef",
      "splashscreen": {
        "path": "splash.html",
        "windowConfig": {
          "width": 400,
          "height": 300,
          "center": true,
          "decorations": false,
          "alwaysOnTop": true
        }
      }
    }]
  }
}
```

### Splash Content
```html
<!-- splash.html -->
<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      margin: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      background: #1a1a1a;
      color: white;
      font-family: system-ui;
    }
    .logo { width: 120px; height: 120px; }
    .status { margin-top: 20px; font-size: 14px; }
    .spinner { /* CSS spinner */ }
  </style>
</head>
<body>
  <img class="logo" src="icons/icon.png" alt="CaveChef">
  <div class="status" id="status">Loading...</div>
  <div class="spinner"></div>
</body>
</html>
```

### Lifecycle
1. App starts → Splash shows
2. Tauri initializes
3. Frontend bundle loads
4. App state hydrates
5. Ready → Close splash, show main window

### Status Updates
Splash shows current initialization step:
- "Loading..."
- "Initializing database..."
- "Loading configuration..."
- "Ready"

### Close Timing
- Close splash when main window is ready
- Use Tauri API to close splash
- Smooth transition (no flicker)

```rust
// In main.rs or lib.rs
#[tauri::command]
fn close_splash(window: tauri::Window) {
    if let Some(splash) = window.get_window("splashscreen") {
        splash.close().unwrap();
    }
    window.get_window("main").unwrap().show().unwrap();
}
```

### Design Considerations
- Simple, clean design
- Matches app theme (dark)
- No animations that delay ready state
- Consider v2: revisit with better design

## Acceptance Criteria
- [ ] Splash screen appears on launch
- [ ] Logo displayed correctly
- [ ] Status text updates
- [ ] Closes when app ready
- [ ] No flicker on transition
- [ ] Works on all platforms
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Rust Tests
1. Test close_splash command works
2. Test main window shown after splash close
3. Test splash window has correct dimensions

### Playwright Tests (Mocked IPC)
1. Test splash HTML renders correctly
2. Test logo image displays
3. Test status text element exists
4. Test spinner animation runs

### WebdriverIO Tests (Full App)
1. Test splash appears on cold start
2. Test splash shows logo correctly
3. Test splash closes when app ready
4. Test no flicker on transition
5. Test splash timing < 3 seconds
6. Test splash works on all platforms

## Edge Cases
- Very fast startup (splash barely visible)
- Initialization error during splash
- User tries to interact before ready
- Multiple monitor setups
