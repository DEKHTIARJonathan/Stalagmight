# fn-4-7mg.4 Add debug.map.showHitboxes visualization

## Description
Add debug visualization with click-only logging (not hover).

## Debug Logging Scope

**Log only on CLICK and CONTEXTMENU**, NOT on hover/mousemove (prevents console spam):

```typescript
// DO log in click handlers
private handleStationClick = (e: MapLayerMouseEvent) => {
  if (this.config?.debug?.map?.log_hit_detection) {
    console.log('[HitDetection] Station click', {
      layer: this.stationsHitboxLayerId,
      featureId: e.features?.[0]?.properties?.id,
      coordinates: e.lngLat,
    });
  }
  // ...
};

// DO log in context menu
private handleContextMenu = (e: MapLayerMouseEvent) => {
  if (this.config?.debug?.map?.log_hit_detection) {
    console.log('[HitDetection] Context menu', { ... });
  }
  // ...
};

// DO NOT log in hover handlers (spam)
private handleStationEnter = (e: MapLayerMouseEvent) => {
  // NO logging here - fires on every mouse move
  // ...
};
```

## Debug Visualization

Set BOTH color AND opacity:

```typescript
private updateDebugVisualization(): void {
  const show = this.config?.debug?.map?.show_hitboxes ?? false;

  if (show) {
    // Debug: visible red with opacity 1
    this.map.setPaintProperty(this.stationsHitboxLayerId, 'circle-color', 'rgba(255,0,0,0.3)');
    this.map.setPaintProperty(this.stationsHitboxLayerId, 'circle-opacity', 1);
    // Same for shots and ghost layers
  } else {
    // Normal: transparent with tiny opacity
    this.map.setPaintProperty(this.stationsHitboxLayerId, 'circle-color', 'rgba(0,0,0,0)');
    this.map.setPaintProperty(this.stationsHitboxLayerId, 'circle-opacity', 0.001);
    // Same for shots and ghost layers
  }
}
```
## CRITICAL: Must Set BOTH Color AND Opacity

Setting only color alpha won't show debug overlay if layer opacity is near-zero. Must set BOTH:
- Color with alpha (e.g., `rgba(255, 0, 0, 0.3)`)
- Layer opacity to 1 (or debug value)

## Implementation in SurveyLayer.tsx

### updateDebugVisualization() method

```typescript
private updateDebugVisualization(): void {
  if (!this.map || !this.config) return;

  const showHitboxes = this.config.debug?.map?.showHitboxes ?? false;

  if (showHitboxes) {
    // Debug mode: visible red overlay
    // MUST set both color AND opacity
    this.map.setPaintProperty(this.stationsHitboxLayerId, 'circle-color', 'rgba(255, 0, 0, 0.3)');
    this.map.setPaintProperty(this.stationsHitboxLayerId, 'circle-opacity', 1);

    this.map.setPaintProperty(this.shotsHitboxLayerId, 'line-color', 'rgba(255, 0, 0, 0.3)');
    this.map.setPaintProperty(this.shotsHitboxLayerId, 'line-opacity', 1);

    // Ghost hitboxes
    this.map.setPaintProperty(this.ghostStationsHitboxLayerId, 'circle-color', 'rgba(255, 0, 0, 0.3)');
    this.map.setPaintProperty(this.ghostStationsHitboxLayerId, 'circle-opacity', 1);

    this.map.setPaintProperty(this.ghostShotsHitboxLayerId, 'line-color', 'rgba(255, 0, 0, 0.3)');
    this.map.setPaintProperty(this.ghostShotsHitboxLayerId, 'line-opacity', 1);
  } else {
    // Normal mode: near-invisible (0.001 opacity for queryRenderedFeatures)
    this.map.setPaintProperty(this.stationsHitboxLayerId, 'circle-color', 'rgba(0, 0, 0, 0)');
    this.map.setPaintProperty(this.stationsHitboxLayerId, 'circle-opacity', 0.001);

    this.map.setPaintProperty(this.shotsHitboxLayerId, 'line-color', 'rgba(0, 0, 0, 0)');
    this.map.setPaintProperty(this.shotsHitboxLayerId, 'line-opacity', 0.001);

    // Ghost hitboxes
    this.map.setPaintProperty(this.ghostStationsHitboxLayerId, 'circle-color', 'rgba(0, 0, 0, 0)');
    this.map.setPaintProperty(this.ghostStationsHitboxLayerId, 'circle-opacity', 0.001);

    this.map.setPaintProperty(this.ghostShotsHitboxLayerId, 'line-color', 'rgba(0, 0, 0, 0)');
    this.map.setPaintProperty(this.ghostShotsHitboxLayerId, 'line-opacity', 0.001);
  }
}
```

### Call from setConfig()

The `setConfig()` method should call `updateDebugVisualization()` after `updateHitboxLayers()`.

### Debug logging

Add logging in event handlers when `debug.map.logHitDetection` is true:

```typescript
private handleStationClick = (e: MapLayerMouseEvent) => {
  if (this.config?.debug?.map?.logHitDetection) {
    console.log('[HitDetection] Station click', {
      layer: this.stationsHitboxLayerId,
      featureId: e.features?.[0]?.properties?.id,
      coordinates: e.lngLat,
      featuresCount: e.features?.length ?? 0,
    });
  }
  // ... existing logic
};
```

Add similar logging to:
- `handleShotClick`
- `handleStationEnter`
- `handleShotEnter`

## Visual result

When `debug.map.showHitboxes = true`:
- Station hitboxes: red semi-transparent circles (radius = hitArea)
- Shot hitboxes: red semi-transparent thick lines (width = hitArea)
- Visual layers render ON TOP of debug overlay (correct z-order)
## Implementation in SurveyLayer.tsx

### Add updateDebugVisualization() method

```typescript
private updateDebugVisualization(): void {
  if (!this.map || !this.config) return;

  const showHitboxes = this.config.debug?.map?.showHitboxes ?? false;
  const debugColor = 'rgba(255, 0, 0, 0.3)';  // Semi-transparent red
  const transparentColor = 'rgba(0, 0, 0, 0)';

  // Station hitbox
  this.map.setPaintProperty(
    this.stationsHitboxLayerId,
    'circle-color',
    showHitboxes ? debugColor : transparentColor
  );

  // Shot hitbox
  this.map.setPaintProperty(
    this.shotsHitboxLayerId,
    'line-color',
    showHitboxes ? debugColor : transparentColor
  );

  // Ghost hitboxes (same treatment)
  this.map.setPaintProperty(
    this.ghostStationsHitboxLayerId,
    'circle-color',
    showHitboxes ? debugColor : transparentColor
  );
  this.map.setPaintProperty(
    this.ghostShotsHitboxLayerId,
    'line-color',
    showHitboxes ? debugColor : transparentColor
  );
}
```

### Call from setConfig()

The `setConfig()` method (added in task 2) should call `updateDebugVisualization()` after `updateHitboxLayers()`.

### Debug logging

Add logging in event handlers when `debug.map.logHitDetection` is true:

```typescript
private handleStationClick = (e: MapLayerMouseEvent) => {
  if (this.config?.debug?.map?.logHitDetection) {
    console.log('[HitDetection] Station click', {
      layer: this.stationsHitboxLayerId,
      featureId: e.features?.[0]?.properties?.id,
      coordinates: e.lngLat,
    });
  }
  // ... existing logic
};
```

Add similar logging to:
- `handleShotClick`
- `handleStationEnter`
- `handleShotEnter`

## Visual result

When `debug.map.showHitboxes = true`:
- Station hitboxes appear as red semi-transparent circles (radius = hitArea)
- Shot hitboxes appear as red semi-transparent thick lines (width = hitArea)
- Visual layers render ON TOP of debug overlay
- User can see both the actual element and its surrounding hitbox area
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
- [ ] `logHitDetection` logs only on click and contextmenu
- [ ] NO logging in mouseenter/mouseleave handlers
- [ ] Debug visualization sets BOTH color AND opacity
- [ ] Debug mode: opacity = 1, color = rgba(255,0,0,0.3)
- [ ] Normal mode: opacity = 0.001, color = opaque (e.g., #000000) - NOT transparent rgba(0,0,0,0) which breaks queryRenderedFeatures (see pitfalls.md)
- [ ] Ghost hitbox layers: opacity = 0 when debug off (not used for hit detection)
- [ ] `pnpm tsc --noEmit` passes
## Done summary
Added debug.map.showHitboxes visualization that sets BOTH color AND opacity on hitbox layers. Debug mode shows semi-transparent red overlay (opacity=1, color=rgba(255,0,0,0.3)), normal mode uses opaque color with tiny opacity (0.001) to maintain queryRenderedFeatures functionality. Added debug logging to click/contextmenu handlers only (not hover) when logHitDetection is enabled.
## Evidence
- Commits: 7f47484, 603987b, 9ad23eb
- Tests: pnpm tsc --noEmit, pnpm test:ui
- PRs: