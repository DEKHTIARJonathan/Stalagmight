# fn-4-7mg.4 Add debug.map.showHitboxes visualization

## Description
Add debug visualization for hitbox layers when `debug.map.showHitboxes` config is enabled.

## Implementation

### Paint Property Toggle

When `debug.map.showHitboxes` is true:
- Station hitbox: `circle-color: rgba(255, 0, 0, 0.3)` (semi-transparent red)
- Shot hitbox: `line-color: rgba(255, 0, 0, 0.3)` (semi-transparent red)
- Ghost hitbox layers: Same red overlay

When false:
- All hitbox layers use `rgba(0, 0, 0, 0)` (fully transparent)

### Config Reactivity

Add method `updateDebugVisualization(showHitboxes: boolean)` that:
1. Updates paint properties on all hitbox layers
2. Called when config is reloaded

### Debug Logging

When `debug.map.logHitDetection` is true:
- Log to console when click/hover hits a hitbox layer
- Include: layer name, feature ID, coordinates

```typescript
if (config.debug.map.logHitDetection) {
  console.log('[HitDetection]', {
    layer: 'survey-stations-hitbox',
    featureId: feature.properties.id,
    coordinates: e.lngLat
  });
}
```

### Visual Layer Order

Hitbox layers remain below visual layers so:
- Red debug overlay shows around/under the actual station/shot
- User can see both the actual element and its hitbox area
## Acceptance
- [ ] Hitbox layers show red overlay when `debug.map.showHitboxes` is true
- [ ] Hitbox layers are transparent when `debug.map.showHitboxes` is false
- [ ] Visual layers render on top of hitbox debug overlay
- [ ] Hit detection events logged when `debug.map.logHitDetection` is true
- [ ] Logs include layer name, feature ID, and coordinates
- [ ] Method to toggle debug visualization on config reload
- [ ] `pnpm tsc --noEmit` passes
- [ ] Manual testing: enable showHitboxes, verify red overlay visible
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
