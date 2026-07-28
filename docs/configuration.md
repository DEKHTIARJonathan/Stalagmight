# Stalagmight Configuration

The reference for `config.toml`. Ground truth is the `Config` struct in
`src-tauri/src/config/types.rs` plus the defaults in
`src-tauri/src/config/defaults.rs` - change those and this file together.

## Config File Location

The directory is Tauri's per-app config dir, named for the bundle identifier
(`com.stalagmight.desktop`).

| Platform | Path |
|----------|------|
| Linux | `~/.config/com.stalagmight.desktop/config.toml` |
| macOS | `~/Library/Application Support/com.stalagmight.desktop/config.toml` |
| Windows | `%APPDATA%\com.stalagmight.desktop\config.toml` |

## Key Config Options

```toml
[general]
auto_save = true                    # Enable auto-save after modifications
auto_save_interval_seconds = 30     # Debounce delay before an auto-save fires
undo_history_limit = 100            # In-memory undo stack depth
undo_persist_limit = 20             # Undo entries persisted into the .stalx on save
recent_projects = []                # List of recently opened project paths
recent_projects_max = 20            # Maximum recent projects to track
locale = "system"                   # "system" or a specific locale tag like "en-US"
number_format = "locale"            # "locale" (follow language) or a locale tag like "de-DE"
date_format = "locale"              # "locale" (follow language) or a locale tag like "en-GB"

[units]
length = "meters"                   # meters, feet
depth = "meters"                    # meters, feet (independent of length)
angle = "degrees"                   # degrees, gradians
# Display decimals per quantity (length 1, coordinates 2, depth 1, azimuth 1,
# inclination 1, gps 6); any subset may be overridden:
decimal_precision = { length = 1, coordinates = 2, depth = 1, azimuth = 1, inclination = 1, gps = 6 }

[display]
default_background = "#1a1a2e"      # Map background color
grid_color = "#333366"              # Grid overlay line color
grid_spacing = 10.0                 # Grid spacing in meters
font_size = 12                      # Map label font size
font_color = "#f5f5f5"              # Map label color
measure_path_color = "#22d3ee"      # Along-line tint for the measure tool's path

[display.depth_gradient]
enabled = false                     # Color shots by depth
shallow_color = "#00bfff"           # Gradient endpoint at shallow_depth
deep_color = "#ff4444"              # Gradient endpoint at deep_depth
shallow_depth = 0.0
deep_depth = 50.0

[section_colors]
# Colors handed to new sections, in order; wraps around when all are used
palette = ["#4ecdc4", "#ff6b6b", "#95e1d3", "#f38181",
           "#aa96da", "#fcbad3", "#a8d8ea", "#ffcb77"]

[appearance]
theme = "dark"                      # "dark", "light", or "auto" (follows OS preference)
day_color_theme = "light"           # Color palette for light/day mode
night_color_theme = "cave"          # Color palette for dark/night mode
# Available color themes:
#   dark, light, cave, dracula, one_dark, solarized_light,
#   catppuccin_latte, nord, catppuccin_mocha, kaleido_eink

[syntactic_highlighting]
level = "full"                      # "off", "toolbar_only", "icons", or "full" (default)
preset = "default"                  # "default", "deuteranopia", "protanopia", "tritanopia"
# Per-preset, per-role color overrides (sparse; only customized colors are stored).
# Roles: segment, section, shot, station, comment, delete, move,
#        select, measure, merge, pan, zoom
# [syntactic_highlighting.overrides.default]
# station = "#36b96a"

[import]
# Which data wins where an imported section overlaps existing shots:
#   "import_data" (use the orphan's), "existing_data" (use the target's),
#   "interpolate" (average), "keep_both" (mark the duplicate as reference)
overlap_mode = "import_data"

[placement_suggestion]
azimuth_sigma = 18.0                # Sigma for azimuth error (degrees)
length_sigma = 0.8                  # Sigma for length error (meters)
depth_sigma = 0.35                  # Sigma for depth error (meters)
azimuth_weight = 0.35               # Weight for azimuth score component
length_weight = 0.25                # Weight for length score component
depth_in_weight = 0.20              # Weight for depth_in score component
depth_out_weight = 0.20             # Weight for depth_out score component
min_shot_score = 0.15               # Minimum per-shot score to continue matching
min_aggregate_score = 0.45          # Minimum aggregate score to include a suggestion
max_reference_shots = 5             # Maximum reference shots to try from each leaf
# Further cutoffs and penalties (max_suggestions, min_partial_ratio,
# single_shot_penalty, short_shot_threshold, max_azimuth_error_*,
# max_depth_error, max_length_error_*) are in config/types.rs.

[map]
satellite_provider = "esri"         # Tile provider (selects from backend registry via get_tile_providers IPC)
satellite_enabled = false           # Show satellite imagery
# GPS origin for coordinate alignment (required for satellite tiles)
satellite_gps_origin = { latitude = 24.55, longitude = -81.78 }
zoom_default = 15                   # Currently unread - the map always opens at 15 (hard-coded in uiStore)
zoom_min = 0                        # Zoom range clamp
zoom_max = 22
zoom_step = 1.0                     # Zoom delta per +/- keypress

# The whole [map.controls] block is currently inert: it parses and persists,
# but no runtime code reads these keys (panning and wheel zoom use MapLibre's
# defaults). Changing them has no effect.
[map.controls]
pan_speed = 1.0                     # Keyboard/edge pan multiplier (unwired)
zoom_speed = 1.0                    # Wheel zoom multiplier (unwired)
invert_scroll = false               # Reverse wheel zoom direction (unwired)

[map.station]
radius = 4                          # Visual circle radius in pixels (1-50)
hit_area = 10                       # Clickable/hoverable area radius in pixels (1-50, >= radius)

[map.shot]
width = 2                           # Visual line width in pixels (0.5-20)
hit_area = 8                        # Clickable/hoverable area width in pixels (0.5-20, >= width)

[map.snap]
threshold = 10                      # Snap detection radius in pixels (1-50)
enabled_merge = true                # Enable snap-to-station in merge tool
enabled_measure = true              # Enable snap-to-station in measure tool

[cache]
tile_cache_enabled = true           # Master switch; the default esri provider still opts out below
tile_cache_max_mb = 500             # Maximum cache size in MB
tile_ttl_days = 30                  # Days before tiles are stale
# Per-provider override. Note: the default config ships esri (the default
# provider) with offline_caching = false, so satellite tiles are NOT cached
# out of the box - flip this to opt in.
# [cache.providers.esri]
# offline_caching = false

[global_view]
fps_threshold = 30                  # FPS below which auto-throttle activates
tolerance = 0.5                     # GeoJSON simplification tolerance (normal)
throttle_tolerance = 1.0            # GeoJSON simplification tolerance (throttled)

[validation]
warn_shot_length_min = 0.3              # Flag shots shorter than this (meters)
warn_shot_length_max = 50.0             # Flag shots longer than this (meters)
warn_depth_change_per_shot_max = 10.0   # Flag depth change over this per shot (meters)
warn_azimuth_deviation_max = 30.0       # Flag azimuth deviation over this (degrees)
azimuth_diff_threshold = 20.0           # Flag when the two (both forward) azimuth readings differ by more than this, after 360-degree wraparound (degrees)
pitch_diff_threshold = 10.0             # Flag when the two recorded inclination legs disagree by more (degrees)
inclination_depth_diff_threshold = 15.0 # Flag recorded inclination vs the one implied by length + depth change (degrees)

[closure_adjustment]
base_sigma_length_m = 0.05          # Per-shot length sigma feeding the least-squares weights
base_sigma_azimuth_deg = 1.0        # Per-shot azimuth sigma (degrees)
base_sigma_depth_m = 0.05           # Per-shot depth sigma (meters)

[panels]
sections_panel_width = 250          # Pixels (clamped to 150-400 on load)
detail_panel_width = 300            # Pixels (clamped to 200-500)
data_table_height = 200             # Pixels (clamped to 100-500)
sections_panel_open = true          # Pinned open at startup
sections_panel_mode = "pin"         # "pin" (click to open, stays open) or "hover"
detail_panel_open = true
detail_panel_mode = "pin"
data_table_open = false
data_table_mode = "pin"
# The data table's column layout is persisted here too:
# data_table_shot_column_order / data_table_station_column_order (empty = declaration
# order), data_table_shot_hidden_columns (default ["section_id", "shot_id"]),
# data_table_station_hidden_columns (default ["_x", "_y", "_lat", "_long"]),
# data_table_azimuth_mode ("avg" | "inout" | "off", default "avg") and
# data_table_inclination_mode (same values, default "off").

[export]
default_image_format = "png"        # Default image format for exports
default_dpi = 300                   # Default raster export DPI
default_include_satellite = true    # Include satellite imagery
default_include_grid = false        # Include the grid overlay
default_include_labels = true       # Include labels

[logging]
level = "info"                      # trace, debug, info, warn, error
max_directory_size_mb = 128         # Cap read by logging::cleanup_logs; nothing invokes it automatically yet

[gas]
units = "metric"                    # "metric" (bar / litres) or "imperial" (psi / cuft)
default_reserve = "all_thirds"      # "all_thirds", "one_stage", "two_stage", or "free"
swim_speed_m_per_min = 10.0         # Exit-leg swim speed
survey_rmv_multiplier = 1.0         # Task-loading RMV bump on the survey-in leg (never below 1.0)
stressed_rmv_multiplier = 1.5       # Stressed-RMV multiplier for bailout / contingency
jump_rmv_multiplier = 1.5           # Extra RMV on jump legs; stacks multiplicatively with survey_rmv_multiplier
include_reference_legs = false      # Escape hatch: treat reference shots as swimmable again
conservative_tank_gas = true        # "Call it an 80" derate instead of precise fill x volume x Z
# survey_speed_m_per_min (unset = same speed both ways) and the dpv scooter
# profile (unset = no scooter) are optional; see config/gas.rs.

[gas.reserve_profile]
stage_reserve_bar = 30.0            # Gas held back in each stage under Half-Minus
all_thirds_safety_margin_bar = 0.0  # Extra bar held back from every cylinder under All-thirds
recalc_hold_stage2_bar = 100.0      # Back-gas held pressures for the Phase-2 return-leg
recalc_hold_stage1_bar = 70.0       # recalc (carried now; that path is not implemented yet)

[speleodb]
# The auth token is never stored here (OS keychain, or the fallback below).
# endpoint = "https://www.speleodb.org"   # Unset by default; DEV_SPELEODB_URL overrides at runtime
# email = "you@example.com"               # Last-used account, prefills the login dialog
token_fallback = "session_only"     # Without a keychain: "session_only" (memory) or "plaintext" (0600 file)
insecure_http = false               # Allow an http:// endpoint to a public host; never relaxes TLS verification
allow_force_edit = false            # Allow editing a remote project without holding the server write lock
poll_interval_seconds = 60          # Remote-state poll cadence; raised to 30 on load if set lower

[debug.map]
show_hitboxes = false               # Show red overlay for interaction hitbox areas
log_hit_detection = false           # Log hit detection events to browser console
```

`[webkit_memory]` exists only for Linux WebKit memory-pressure tuning. It is
backend-only (kept out of the frontend config types and out of `get_config`), so
it is not documented here - see the field comment in `src-tauri/src/config/types.rs`.

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
# File - project and import/export operations
new_file = ["Ctrl+N"]
open_file = ["Ctrl+O"]
save = ["Ctrl+S"]
save_as = ["Ctrl+Shift+S"]
import_dmp = ["Ctrl+I"]
export = ["Ctrl+E"]
quit = ["Ctrl+Q"]

# Tools - single letter keys for quick access
select = ["S"]
pan = ["P"]
zoom = ["Z"]
merge = ["M"]
measure = ["R"]
move_station = ["T"]
move_segment = ["V"]
move_shot = ["G"]
comment_tool = ["C"]
move_comment_tool = ["Shift+C"]

# Edit - standard modifier combinations
undo = ["Ctrl+Z"]
redo = ["Ctrl+Y", "Ctrl+Shift+Z"]   # Two bindings for redo

# View toggles
toggle_depth_gradient = ["Shift+D"]
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
| **File** | `new_file` | `Ctrl+N` | New project |
| | `open_file` | `Ctrl+O` | Open project |
| | `save` | `Ctrl+S` | Save project |
| | `save_as` | `Ctrl+Shift+S` | Save project as |
| | `import_dmp` | `Ctrl+I` | Import DMP file |
| | `export` | `Ctrl+E` | Export project |
| | `quit` | `Ctrl+Q` | Quit the application |
| **Tools** | `select` | `S` | Select tool |
| | `pan` | `P` | Pan/hand tool |
| | `zoom` | `Z` | Zoom tool |
| | `merge` | `M` | Merge tool |
| | `measure` | `R` | Measure tool |
| | `move_station` | `T` | Move station tool |
| | `move_segment` | `V` | Move segment tool |
| | `move_shot` | `G` | Move shot tool |
| | `comment_tool` | `C` | Comment tool |
| | `move_comment_tool` | `Shift+C` | Move comment tool |
| **Edit** | `undo` | `Ctrl+Z` | Undo last action |
| | `redo` | `Ctrl+Y`, `Ctrl+Shift+Z` | Redo last undone action |
| **View** | `toggle_depth_gradient` | `Shift+D` | Toggle depth gradient coloring |
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
| `Tab` / `Enter` | UI navigation |
| `Ctrl+A` | Select all stations |
| `Ctrl+,` (`Cmd+,` on macOS) | Open Settings |
| `?` | Keyboard shortcuts overlay |

`Ctrl+=` / `Ctrl+-` / `Ctrl+0` zoom the interface in / out / reset. The Settings
dialog lists them as reserved, but that is display only - `RESERVED_CTRL_KEYS`
holds just `A` and `,`, so the editor will let you bind them to an action and
the UI-zoom handler still fires alongside it.

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

The old top-level `[snap]` block is migrated on load (`Config::migrate_legacy`),
and only while `map.snap` is still at its defaults. The `display.*` keys were
removed outright: an old config still loads, but the values are ignored rather
than carried over.

| Old Setting | Replacement | Migrated on load |
|-------------|-------------|------------------|
| `display.station_size` | `map.station.radius` | no |
| `display.line_thickness` | `map.shot.width` | no |
| `snap.enabled_merge` | `map.snap.enabled_merge` | yes |
| `snap.enabled_measure` | `map.snap.enabled_measure` | yes |
| `snap.threshold_pixels` | `map.snap.threshold` | yes |

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

Logs are written using the `tracing` crate with `tracing-appender` for file
output, as `stalagmight.log.YYYY-MM-DD`, rotated daily.

Unlike config, the log directory is **not** under the bundle-identifier dir:
`logging::init()` runs before Tauri's path API is initialised
(`src-tauri/src/lib.rs`), so `log_directory()` always takes its
`directories`-crate fallback:

| Platform | Log Path |
|----------|----------|
| Linux | `~/.local/share/stalagmight/logs/` |
| macOS | `~/Library/Application Support/com.stalagmight.Stalagmight/logs/` |
| Windows | `%LOCALAPPDATA%\stalagmight\Stalagmight\data\logs\` |

Level and the directory size cap are the `[logging]` settings above.
