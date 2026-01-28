# CaveChef Configuration

## Config File Location

| Platform | Path |
|----------|------|
| Linux | `~/.config/cavechef/config.toml` |
| macOS | `~/Library/Application Support/cavechef/config.toml` |
| Windows | `%APPDATA%\cavechef\config.toml` |

## Key Config Options

```toml
[general]
auto_save = true                    # Enable auto-save after modifications
recent_projects = []                # List of recently opened project paths
recent_projects_max = 10            # Maximum recent projects to track

[units]
length = "meters"                   # meters, feet
angle = "degrees"                   # degrees, gradians

[display]
default_background = "#1a1a2e"      # Map background color

[map]
satellite_provider = "esri"         # Tile provider (selects from backend registry via get_tile_providers IPC)
satellite_enabled = false           # Show satellite imagery
# GPS origin for coordinate alignment (required for satellite tiles)
satellite_gps_origin = { latitude = 24.55, longitude = -81.78 }

[map.station]
radius = 4                          # Visual circle radius in pixels (1-50)
hit_area = 10                       # Clickable/hoverable area radius in pixels (1-50, >= radius)

[map.shot]
width = 2                           # Visual line width in pixels (0.5-20)
hit_area = 8                        # Clickable/hoverable area width in pixels (0.5-20, >= width)

[map.snap]
threshold = 10                      # Snap detection radius in pixels (1-50)
enabled_draw = true                 # Enable snap-to-station in draw tool
enabled_merge = true                # Enable snap-to-station in merge tool
enabled_measure = true              # Enable snap-to-station in measure tool

[cache]
tile_cache_enabled = true           # Cache satellite tiles for offline use
tile_cache_max_mb = 500             # Maximum cache size in MB
tile_ttl_days = 30                  # Days before tiles are stale

[global_view]
fps_threshold = 30                  # FPS below which auto-throttle activates
tolerance = 0.5                     # GeoJSON simplification tolerance (normal)
throttle_tolerance = 1.0            # GeoJSON simplification tolerance (throttled)

[validation]
# Validation thresholds for warnings

[debug.map]
show_hitboxes = false               # Show red overlay for interaction hitbox areas
log_hit_detection = false           # Log hit detection events to browser console
```

Default config is defined in `src-tauri/src/config/defaults.rs`. See [SPEC.md](SPEC.md) Section 9 for full config schema.

## Keyboard Shortcuts

Shortcuts are configurable via the `[shortcuts]` section. Each action supports up to two key bindings (primary and secondary) as an array of strings.

### Shortcut Format

Shortcuts use the format `Modifier+Modifier+Key`, where:

- **Modifiers** (in order): `Ctrl`, `Alt`, `Shift`
- **Keys**: Single letters (uppercase), numbers, or special key names
- **Platform note**: On macOS, `Ctrl` in config maps to the Command key; on Windows/Linux it maps to Control

**Special key names:**
- `Space`, `Enter`, `Tab`, `Escape`
- `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`
- `Plus`, `Minus`, `Equal`
- `Backspace`, `Delete`, `Home`, `End`, `PageUp`, `PageDown`, `Insert`
- `F1` through `F12` (function keys)

### Configuration Example

```toml
[shortcuts]
# File - import/export operations (user-configurable)
import_dmp = ["Ctrl+I"]
export = ["Ctrl+E"]

# Tools - single letter keys for quick access
select = ["S"]
pan = ["P"]
zoom = ["Z"]
draw = ["D"]
delete_tool = ["X"]
merge = ["M"]
measure = ["R"]
move_section = ["V"]
move_station = ["T"]

# Edit - standard modifier combinations
undo = ["Ctrl+Z"]
redo = ["Ctrl+Y", "Ctrl+Shift+Z"]   # Two bindings for redo
save = ["Ctrl+S"]

# View toggles
toggle_depth_gradient = ["G"]
toggle_grid = ["Shift+G"]
toggle_satellite = ["B"]
toggle_station_labels = ["L"]
toggle_shot_labels = ["Shift+L"]
toggle_section_labels = ["Ctrl+L"]
fit_to_bounds = ["F"]
zoom_in = ["Equal", "Plus"]         # = or + key
zoom_out = ["Minus"]                # - key

# Panel toggles
toggle_sections_panel = ["Ctrl+1"]
toggle_detail_panel = ["Ctrl+2"]
toggle_data_table = ["Ctrl+3"]
```

### All Configurable Actions

| Category | Action | Default | Description |
|----------|--------|---------|-------------|
| **File** | `import_dmp` | `Ctrl+I` | Import DMP file |
| | `export` | `Ctrl+E` | Export project |
| **Tools** | `select` | `S` | Select tool |
| | `pan` | `P` | Pan/hand tool |
| | `zoom` | `Z` | Zoom tool |
| | `draw` | `D` | Draw tool |
| | `delete_tool` | `X` | Delete tool |
| | `merge` | `M` | Merge tool |
| | `measure` | `R` | Measure tool |
| | `move_section` | `V` | Move section tool |
| | `move_station` | `T` | Move station tool |
| **Edit** | `undo` | `Ctrl+Z` | Undo last action |
| | `redo` | `Ctrl+Y`, `Ctrl+Shift+Z` | Redo last undone action |
| | `save` | `Ctrl+S` | Save project |
| **View** | `toggle_depth_gradient` | `G` | Toggle depth gradient coloring |
| | `toggle_grid` | `Shift+G` | Toggle grid overlay |
| | `toggle_satellite` | `B` | Toggle satellite imagery |
| | `toggle_station_labels` | `L` | Toggle station name labels |
| | `toggle_shot_labels` | `Shift+L` | Toggle shot distance labels |
| | `toggle_section_labels` | `Ctrl+L` | Toggle section name labels |
| | `fit_to_bounds` | `F` | Fit map to survey bounds |
| | `zoom_in` | `=`, `+` | Zoom in on map |
| | `zoom_out` | `-` | Zoom out on map |
| **Panels** | `toggle_sections_panel` | `Ctrl+1` | Toggle sections panel |
| | `toggle_detail_panel` | `Ctrl+2` | Toggle detail panel |
| | `toggle_data_table` | `Ctrl+3` | Toggle data table |

### Reserved Shortcuts

The following shortcuts are reserved and cannot be reassigned:

| Shortcut | Action |
|----------|--------|
| `Escape` | Close dialogs, clear selection, cancel operations |
| `Delete` / `Backspace` | Delete selected item (with confirmation) |
| `Ctrl+A` | Select all stations |

### Shortcut Feedback

Control when toast notifications appear for shortcut actions via `general.shortcut_feedback`:

```toml
[general]
shortcut_feedback = "non_obvious"   # "none", "non_obvious", or "all"
```

| Value | Behavior |
|-------|----------|
| `"none"` | No toast notifications for any shortcuts |
| `"non_obvious"` | Toast for view/panel toggles only (default) |
| `"all"` | Toast for all shortcut actions |

### Backward Compatibility

The shortcut system accepts both the legacy single-string format and the new array format:

```toml
# Legacy format (still supported)
select = "S"

# New format (preferred)
select = ["S"]
select = ["S", "Shift+S"]  # Primary + secondary binding
```

Missing shortcut fields are filled with defaults during config loading.

## Deprecated Settings

The following settings have been removed and migrated to new locations:

| Old Setting | New Setting |
|-------------|-------------|
| `display.station_size` | `map.station.radius` |
| `display.line_thickness` | `map.shot.width` |
| `snap.enabled_draw` | `map.snap.enabled_draw` |
| `snap.enabled_merge` | `map.snap.enabled_merge` |
| `snap.enabled_measure` | `map.snap.enabled_measure` |
| `snap.threshold_pixels` | `map.snap.threshold` |

## Settings Dialog

The Settings dialog provides a UI for common configuration changes. Access it by clicking the **Settings** button in the application header. After modifying `config.toml` manually, use the **Reload Config** button in the Settings dialog to apply changes without restarting the application.

### Configuring Shortcuts via UI

1. Click the **Settings** button in the application header
2. Select the **Shortcuts** tab
3. Use the search box to filter actions by name
4. Click on a shortcut field to record a new key combination
5. Press the desired keys to set the binding
6. Press `Escape` to cancel recording, or click the clear (x) button to remove the binding
7. Click **Reset** next to an action to restore its default binding
8. Click **Reset All Shortcuts** at the bottom to restore all shortcuts to defaults

**Conflict detection**: The UI warns when a shortcut conflicts with another action or reserved shortcut. Conflicting bindings are highlighted in the UI.

## Logging

Logs are written using the `tracing` crate with `tracing-appender` for file output.

| Platform | Log Path |
|----------|----------|
| Linux | `~/.local/share/cavechef/logs/` |
| macOS | `~/Library/Application Support/cavechef/logs/` |
| Windows | `%APPDATA%\cavechef\logs\` |

Log level is configurable in the config file.
