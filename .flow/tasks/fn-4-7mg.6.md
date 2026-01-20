# fn-4-7mg.6 Update docs/configuration.md with new settings

## Description
Update docs/configuration.md to document the new hitbox and debug settings.

## Documentation Updates

### Add New Sections

Add to `[map]` section:

```toml
[map.station]
radius = 4              # Visual circle radius in pixels (1-50)
hitArea = 10            # Clickable/hoverable area radius in pixels (1-50)

[map.shot]
width = 2               # Visual line width in pixels (0.5-20)
hitArea = 8             # Clickable/hoverable area width in pixels (0.5-20)

[map.snap]
threshold = 10          # Snap detection radius in pixels (1-50)
enabledDraw = true      # Enable snap-to-station in draw tool
enabledMerge = true     # Enable snap-to-station in merge tool
enabledMeasure = true   # Enable snap-to-station in measure tool
```

Add new `[debug]` section:

```toml
[debug.map]
showHitboxes = false    # Show red overlay for interaction hitbox areas
logHitDetection = false # Log hit detection events to browser console
```

### Remove Deprecated Settings

Note that the following settings have been removed/migrated:
- `display.station_size` → `map.station.radius`
- `display.line_thickness` → `map.shot.width`
- `snap.enabled_draw` → `map.snap.enabledDraw`
- `snap.enabled_merge` → `map.snap.enabledMerge`
- `snap.enabled_measure` → `map.snap.enabledMeasure`
- `snap.threshold_pixels` → `map.snap.threshold`

### Add Reload Config Note

Document the "Reload Config" button in Settings dialog for applying config changes without restart.
## Acceptance
- [ ] `map.station` settings documented with descriptions and bounds
- [ ] `map.shot` settings documented with descriptions and bounds
- [ ] `map.snap` settings documented with descriptions
- [ ] `debug.map` settings documented
- [ ] Deprecated/removed settings noted
- [ ] "Reload Config" button documented
- [ ] Example config shows complete new structure
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
