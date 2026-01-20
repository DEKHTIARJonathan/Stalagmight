# fn-4-7mg.2 Add transparent hitbox layers to SurveyLayer

## Description
Add transparent hitbox layers to SurveyLayer that render beneath the visual layers. These layers have larger sizes (from config) but are fully transparent, providing enlarged clickable/hoverable areas.

## Implementation

### New Layers (in `SurveyLayer.tsx`)

Add before existing visual layers:

1. **`survey-stations-hitbox`**: Circle layer
   - Source: Same `survey-features` source
   - Filter: `['==', ['get', 'type'], 'station']`
   - Paint:
     - `circle-radius`: `config.map.station.hitArea` (default 10)
     - `circle-color`: `rgba(0,0,0,0)` (fully transparent)
     - `circle-stroke-width`: 0

2. **`survey-shots-hitbox`**: Line layer
   - Source: Same `survey-features` source
   - Filter: `['==', ['get', 'type'], 'shot']`
   - Paint:
     - `line-width`: `config.map.shot.hitArea` (default 8)
     - `line-color`: `rgba(0,0,0,0)` (fully transparent)
     - `line-cap`: `round` (better endpoint detection)

3. **Ghost hitbox layers** (for merge preview):
   - `survey-ghost-stations-hitbox`
   - `survey-ghost-shots-hitbox`
   - Same paint properties, using ghost source

### Layer Order

From bottom to top:
1. `survey-stations-hitbox` (new)
2. `survey-shots-hitbox` (new)
3. `survey-ghost-stations-hitbox` (new)
4. `survey-ghost-shots-hitbox` (new)
5. `survey-merges` (existing)
6. `survey-loop-closures` (existing)
7. `survey-shots` (existing)
8. `survey-ghost-shots` (existing)
9. `survey-stations` (existing)
10. `survey-ghost-stations` (existing)
11. Labels...

### Config Integration

- Read `map.station.hitArea` and `map.shot.hitArea` from config
- Also update visual layers to use `map.station.radius` and `map.shot.width`
- Add methods to update hitbox layer paint properties when config changes
## Acceptance
- [ ] `survey-stations-hitbox` layer added with correct paint properties
- [ ] `survey-shots-hitbox` layer added with correct paint properties
- [ ] Ghost hitbox layers added for merge preview
- [ ] Hitbox layers render below visual layers
- [ ] Hitbox layers use config values for sizes
- [ ] Visual layers updated to use `map.station.radius` and `map.shot.width`
- [ ] Method to update hitbox sizes when config reloads
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
