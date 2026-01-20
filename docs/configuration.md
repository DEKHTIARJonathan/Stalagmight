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
satellite_provider = "esri"         # Tile provider
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

[validation]
# Validation thresholds for warnings

[debug.map]
show_hitboxes = false               # Show red overlay for interaction hitbox areas
log_hit_detection = false           # Log hit detection events to browser console
```

Default config is defined in `src-tauri/src/config/defaults.rs`. See [SPEC.md](SPEC.md) Section 9 for full config schema.

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

The Settings dialog (`Ctrl+,` / `Cmd+,`) provides a UI for common configuration changes. After modifying `config.toml` manually, use the **Reload Config** button in the Settings dialog to apply changes without restarting the application.

## Logging

Logs are written using the `tracing` crate with `tracing-appender` for file output.

| Platform | Log Path |
|----------|----------|
| Linux | `~/.local/share/cavechef/logs/` |
| macOS | `~/Library/Application Support/cavechef/logs/` |
| Windows | `%APPDATA%\cavechef\logs\` |

Log level is configurable in the config file.
