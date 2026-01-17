# Task 51: Debounced Auto-Save

## Overview
Implement 2-second debounced auto-save to prevent save storms during rapid edits. Show pending save indicator and provide manual "Save Now" option.

## Priority
Low-Medium - Phase F (Performance)

## Risk Level
Low-Medium

## Dependencies
- Existing auto-save infrastructure

## Files to Modify
- `src-tauri/src/core/state.rs` - Debounce logic
- `src/store/projectStore.ts` - Track pending save state
- `src/components/StatusBar.tsx` - Pending save indicator

## Specifications

### Debounce Logic
```rust
// In state.rs
fn schedule_autosave(&self) {
    // Cancel any pending autosave
    if let Some(handle) = self.autosave_handle.take() {
        handle.cancel();
    }

    // Schedule new autosave after delay
    let delay = self.config.autosave_delay_ms; // default 2000
    let handle = schedule_delayed(delay, || {
        self.save_project(None);
    });
    self.autosave_handle = Some(handle);
}
```

### Configuration
```toml
# config.toml
[general]
auto_save = true
auto_save_delay_ms = 2000  # NEW: configurable delay
```

### Save States
1. **Saved**: No pending changes
2. **Pending**: Changes waiting for debounce
3. **Saving**: Currently writing to disk
4. **Error**: Save failed

### Visual Indicators
- Status bar shows current state
- Window title asterisk (*) for unsaved changes
- Different icons for pending vs saving

### "Save Now" Option
- Ctrl+S always available
- Immediately saves (cancels debounce)
- Works regardless of auto-save setting

### Pending Save Indicator
- Status bar: "Saving in 2s..."
- Or: small spinning indicator
- Countdown optional (may be distracting)

### Error Handling
- If save fails, don't retry automatically
- Show error in status bar
- User can manual retry with Ctrl+S

### Edge Cases
- App quit with pending save
- Multiple rapid commands
- Save during pending save

## Acceptance Criteria
- [ ] 2-second debounce working
- [ ] Pending state shown in status bar
- [ ] Window title shows unsaved state
- [ ] Ctrl+S saves immediately
- [ ] Delay is configurable
- [ ] App quit triggers immediate save
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Rust Tests
1. Test autosave scheduled after command
2. Test pending autosave cancelled on new command
3. Test autosave executes after delay
4. Test delay configurable from config
5. Test Ctrl+S cancels pending and saves immediately

### Playwright Tests (Mocked IPC)
1. Test pending save indicator appears in status bar
2. Test asterisk (*) appears in window title
3. Test indicator clears after save
4. Test Ctrl+S triggers immediate save
5. Test debounce resets on new edit
6. Test save error shows in status bar

### WebdriverIO Tests (Full App)
1. Test 2-second debounce timing accurate
2. Test rapid edits only trigger one save
3. Test save actually writes to disk
4. Test app quit with pending save triggers save
5. Test configurable delay from settings

## Edge Cases
- Rapid edits faster than debounce
- Edit during active save
- Config change during pending save
- Low disk space during save
