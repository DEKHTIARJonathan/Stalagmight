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
angle = "degrees"                   # degrees, grads

[display]
default_background = "#1a1a2e"      # Map background color

[validation]
# Validation thresholds for warnings
```

Default config is defined in `src-tauri/src/config/defaults.rs`. See [SPEC.md](SPEC.md) Section 9 for full config schema.

## Logging

Logs are written using the `tracing` crate with `tracing-appender` for file output.

| Platform | Log Path |
|----------|----------|
| Linux | `~/.local/share/cavechef/logs/` |
| macOS | `~/Library/Application Support/cavechef/logs/` |
| Windows | `%APPDATA%\cavechef\logs\` |

Log level is configurable in the config file.
