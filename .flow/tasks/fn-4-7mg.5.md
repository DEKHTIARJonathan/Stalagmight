# fn-4-7mg.5 Add Reload Config button to Settings dialog

## Description
Add a "Reload Config" button to the Settings dialog that re-reads the config file and applies changes immediately.

## Implementation

### Settings Dialog UI

Add button to Settings dialog footer:
- Button text: "Reload Config"
- Position: Settings dialog footer, left side
- Style: Secondary/outline button

### Reload Logic

1. Call Tauri command to re-read config file from disk
2. Update React config state with new values
3. Propagate changes to all consumers (SurveyLayer, MapCanvas, etc.)

### Toast Notification

After reload:
1. Compare old config with new config
2. Build list of changed settings (key path + old value + new value)
3. Show toast with changes

Example toast:
```
Config reloaded:
- map.station.hitArea: 10 → 15
- map.shot.hitArea: 8 → 12
```

If no changes:
```
Config reloaded (no changes)
```

### Tauri Command

May need new command or modify existing:
```rust
#[tauri::command]
fn reload_config() -> Result<Config, String>
```

### Error Handling

If config file has parse errors:
- Show error toast with details
- Keep previous config (don't crash)
## Acceptance
- [ ] "Reload Config" button added to Settings dialog footer
- [ ] Button triggers config file re-read from disk
- [ ] Config changes propagate to all components
- [ ] Toast shows list of changed settings
- [ ] Toast shows "no changes" if config unchanged
- [ ] Error toast shown if config file has parse errors
- [ ] Previous config preserved on parse error
- [ ] `pnpm tsc --noEmit` passes
- [ ] Manual testing: change config file, click Reload, verify toast and effect
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
