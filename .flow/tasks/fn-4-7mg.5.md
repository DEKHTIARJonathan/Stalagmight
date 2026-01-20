# fn-4-7mg.5 Add Reload Config button to Settings dialog

## Description
Add Reload Config button that updates store WITHOUT persisting.

## CRITICAL: Don't Call update_config

`update_config` saves to disk. On reload, we only want to refresh from disk, NOT save back:

```typescript
const handleReloadConfig = async () => {
  try {
    const newConfig = await invoke<Config>('reload_config');
    const changes = computeConfigDiff(localConfig, newConfig);

    setLocalConfig(newConfig);

    // Update store directly - DO NOT call updateConfig() which would persist
    // Use internal store method or direct setState
    const store = useProjectStore.getState();
    useProjectStore.setState({ config: newConfig });

    if (changes.length > 0) {
      const changeList = changes.map(c => `• ${c.path}: ${c.oldValue} → ${c.newValue}`).join('\n');
      alert(`Config reloaded:\n\n${changeList}`);
    } else {
      alert('Config reloaded (no changes)');
    }
  } catch (error) {
    alert(`Failed to reload config: ${error}`);
  }
};
```

## Rust Command

```rust
#[tauri::command]
pub fn reload_config(state: State<AppState>) -> Result<Config, String> {
    let new_config = Config::load().map_err(|e| e.to_string())?;
    *state.config.lock().unwrap() = new_config.clone();
    Ok(new_config)
}
```

## UX

- Button disabled when `isDirty`
- Tooltip: "Save or discard local changes first"

## Client-Side Diffing

```typescript
function computeConfigDiff(old: Config, new_: Config) {
  const changes = [];
  // Compare map.station.radius, map.station.hit_area, etc.
  return changes;
}
```
## API Contract

`reload_config` returns **only the new Config** (simpler than returning diff):

```rust
#[tauri::command]
pub fn reload_config(state: State<AppState>) -> Result<Config, String> {
    let new_config = Config::load().map_err(|e| e.to_string())?;
    *state.config.lock().unwrap() = new_config.clone();
    Ok(new_config)
}
```

## Client-Side Diffing

Frontend computes diff (more flexible, easier to maintain):

```typescript
function computeConfigDiff(
  oldConfig: Config,
  newConfig: Config
): { path: string; oldValue: string; newValue: string }[] {
  const changes: { path: string; oldValue: string; newValue: string }[] = [];

  // Check map.station
  if (oldConfig.map.station.radius !== newConfig.map.station.radius) {
    changes.push({
      path: 'map.station.radius',
      oldValue: String(oldConfig.map.station.radius),
      newValue: String(newConfig.map.station.radius),
    });
  }
  if (oldConfig.map.station.hit_area !== newConfig.map.station.hit_area) {
    changes.push({
      path: 'map.station.hit_area',
      oldValue: String(oldConfig.map.station.hit_area),
      newValue: String(newConfig.map.station.hit_area),
    });
  }
  // ... check other relevant fields

  return changes;
}
```

## Implementation

```typescript
const handleReloadConfig = async () => {
  try {
    const newConfig = await invoke<Config>('reload_config');
    const changes = computeConfigDiff(localConfig, newConfig);

    setLocalConfig(newConfig);
    updateConfig(newConfig);  // Update store

    if (changes.length > 0) {
      const changeList = changes
        .map(c => `• ${c.path}: ${c.oldValue} → ${c.newValue}`)
        .join('\n');
      alert(`Config reloaded:\n\n${changeList}`);
    } else {
      alert('Config reloaded (no changes)');
    }
  } catch (error) {
    alert(`Failed to reload config: ${error}`);
  }
};
```

## UX

- Button disabled when `isDirty` (pending local edits)
- Tooltip: "Save or discard local changes first"
## UX: Disable When isDirty

The Settings dialog has local state (`localConfig`, `isDirty`) for pending edits. Reload button should be disabled when there are unsaved local changes to avoid confusion.

## Implementation

### SettingsDialog.tsx

**Add reload button to dialog footer**:

```typescript
<DialogFooter>
  <Button
    variant="outline"
    onClick={handleReloadConfig}
    disabled={isDirty}
    title={isDirty ? "Save or discard local changes first" : "Reload config from file"}
  >
    Reload Config
  </Button>
  <Button variant="outline" onClick={handleClose}>
    Cancel
  </Button>
  <Button onClick={handleSave} disabled={!isDirty}>
    Save
  </Button>
</DialogFooter>
```

**Add handleReloadConfig function**:

```typescript
const handleReloadConfig = async () => {
  try {
    const result = await invoke<{ config: Config; changes: ConfigChange[] }>('reload_config');

    setLocalConfig(result.config);
    updateConfig(result.config);  // Update store

    if (result.changes.length > 0) {
      // Show changes via existing dialog pattern
      // Could use alert() or a simple modal showing the diff
      const changeList = result.changes
        .map(c => `• ${c.path}: ${c.old_value} → ${c.new_value}`)
        .join('\n');
      alert(`Config reloaded:\n\n${changeList}`);
    } else {
      alert('Config reloaded (no changes)');
    }
  } catch (error) {
    alert(`Failed to reload config: ${error}`);
  }
};
```

### Rust command (src-tauri/src/commands/config.rs)

**Add reload_config command that returns changes**:

```rust
#[derive(Serialize)]
pub struct ConfigChange {
    path: String,
    old_value: String,
    new_value: String,
}

#[derive(Serialize)]
pub struct ReloadConfigResult {
    config: Config,
    changes: Vec<ConfigChange>,
}

#[tauri::command]
pub fn reload_config(state: tauri::State<'_, AppState>) -> Result<ReloadConfigResult, String> {
    let new_config = Config::load().map_err(|e| e.to_string())?;

    let mut state_guard = state.config.lock().unwrap();
    let old_config = state_guard.clone();

    // Compute changes (simplified - compare key fields)
    let changes = compute_config_diff(&old_config, &new_config);

    *state_guard = new_config.clone();

    Ok(ReloadConfigResult {
        config: new_config,
        changes,
    })
}

fn compute_config_diff(old: &Config, new: &Config) -> Vec<ConfigChange> {
    let mut changes = Vec::new();

    // Compare map.station settings
    if old.map.station.radius != new.map.station.radius {
        changes.push(ConfigChange {
            path: "map.station.radius".to_string(),
            old_value: old.map.station.radius.to_string(),
            new_value: new.map.station.radius.to_string(),
        });
    }
    // ... compare other relevant fields

    changes
}
```

Register in main.rs with other config commands.

## Error handling

- If config file has parse errors, show error via alert with details
- Keep previous config in state (don't crash)
- Log detailed error to console for debugging

## No new toast system needed

Use existing patterns: `alert()` for simple feedback, or existing dialog components if available. Don't introduce new toast infrastructure in this change.
## Scope

This task adds only the reload button. Config editing remains file-only (no UI sliders for hitArea values in this iteration).

## Implementation

### SettingsDialog.tsx

**Add reload button to dialog footer** (around L162-185):

```typescript
<DialogFooter>
  <Button variant="outline" onClick={handleReloadConfig}>
    Reload Config
  </Button>
  <Button variant="outline" onClick={handleClose}>
    Cancel
  </Button>
  <Button onClick={handleSave} disabled={!isDirty}>
    Save
  </Button>
</DialogFooter>
```

**Add handleReloadConfig function:**

```typescript
const handleReloadConfig = async () => {
  try {
    const newConfig = await invoke<Config>('reload_config');
    const changes = diffConfigs(localConfig, newConfig);

    setLocalConfig(newConfig);
    updateConfig(newConfig);  // Update store

    if (changes.length > 0) {
      toast.success(`Config reloaded:\n${changes.map(c => `• ${c.path}: ${c.old} → ${c.new}`).join('\n')}`);
    } else {
      toast.info('Config reloaded (no changes)');
    }
  } catch (error) {
    toast.error(`Failed to reload config: ${error}`);
  }
};
```

**Add diffConfigs helper:**

```typescript
function diffConfigs(oldConfig: Config, newConfig: Config): { path: string; old: unknown; new: unknown }[] {
  const changes: { path: string; old: unknown; new: unknown }[] = [];
  // Deep compare configs, collect differences
  // Focus on map.station.*, map.shot.*, map.snap.*, debug.map.*
  return changes;
}
```

### Rust command (src-tauri/src/commands/config.rs)

**Add reload_config command:**

```rust
#[tauri::command]
pub fn reload_config(state: tauri::State<'_, AppState>) -> Result<Config, String> {
    let config = Config::load().map_err(|e| e.to_string())?;
    *state.config.lock().unwrap() = config.clone();
    Ok(config)
}
```

Register in main.rs with other config commands.

## Error handling

- If config file has parse errors, show error toast with details
- Keep previous config in state (don't crash)
- Log detailed error to console for debugging

## Toast feedback

Success toast shows changed settings:
```
Config reloaded:
• map.station.hitArea: 10 → 15
• map.shot.hitArea: 8 → 12
```

No changes toast:
```
Config reloaded (no changes)
```

Error toast:
```
Failed to reload config: TOML parse error at line 45...
```
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
- [ ] Reload updates store WITHOUT persisting (no updateConfig call)
- [ ] Uses setState or internal method to update config state
- [ ] Client-side diffing with computeConfigDiff()
- [ ] Button disabled when isDirty
- [ ] `cargo test` passes
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
