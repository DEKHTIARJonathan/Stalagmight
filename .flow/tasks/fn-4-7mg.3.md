# fn-4-7mg.3 Update click/hover event handlers to use hitbox layers

## Description
Update ALL interaction event handlers and feature-presence checks to use hitbox layers.

## CRITICAL: Global Empty-Click Handler

SurveyLayer has a global `map.on('click', ...)` handler that fires for ALL clicks, not just layer-specific. It queries visual layers to detect if click hit empty space. **Must update to query hitbox layers**, otherwise clicks inside hitbox but outside visual glyph will incorrectly trigger empty-space behavior.

## CRITICAL: Nearest-to-Click Resolution

Don't rely on `features[0]` from `queryRenderedFeatures` - it's render-order dependent. For overlapping hitboxes, compute nearest by distance.

### Add centralized hit resolver

```typescript
private resolveNearestFeature(
  e: MapLayerMouseEvent,
  features: MapGeoJSONFeature[]
): MapGeoJSONFeature | null {
  if (features.length === 0) return null;
  if (features.length === 1) return features[0];

  // Project each feature to screen coords, find nearest to click
  let nearest = features[0];
  let nearestDist = Infinity;

  for (const feature of features) {
    const geom = feature.geometry;
    if (geom.type === 'Point') {
      const screenPos = this.map.project(geom.coordinates as [number, number]);
      const dist = Math.sqrt(
        (screenPos.x - e.point.x) ** 2 + (screenPos.y - e.point.y) ** 2
      );
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = feature;
      }
    }
    // For LineString (shots), use midpoint or nearest point on line
  }
  return nearest;
}
```

### Use resolver in all handlers

```typescript
private handleStationClick = (e: MapLayerMouseEvent) => {
  const feature = this.resolveNearestFeature(e, e.features ?? []);
  if (!feature) return;
  // ... rest of handler
};
```

## SurveyLayer.tsx Changes

### Per-layer click handlers

```typescript
// Station click - move to hitbox layer
this.map.on('click', this.stationsHitboxLayerId, this.handleStationClick);

// Shot click - move to hitbox layer
this.map.on('click', this.shotsHitboxLayerId, this.handleShotClick);
```

### Per-layer hover handlers

```typescript
this.map.on('mouseenter', this.stationsHitboxLayerId, this.handleStationEnter);
this.map.on('mouseleave', this.stationsHitboxLayerId, this.handleStationLeave);
this.map.on('mouseenter', this.shotsHitboxLayerId, this.handleShotEnter);
this.map.on('mouseleave', this.shotsHitboxLayerId, this.handleShotLeave);
```

### Global empty-click handler (CRITICAL)

Find the global click handler that checks for empty space. Update queries:

```typescript
// BEFORE (queries visual layers):
const stationFeatures = this.map.queryRenderedFeatures(e.point, {
  layers: [this.stationsLayerId]
});

// AFTER (queries hitbox layers):
const stationFeatures = this.map.queryRenderedFeatures(e.point, {
  layers: [this.stationsHitboxLayerId]
});
const shotFeatures = this.map.queryRenderedFeatures(e.point, {
  layers: [this.shotsHitboxLayerId]
});
```

### Context menu handler

Update to query hitbox layers AND use nearest resolver:

```typescript
const stationFeatures = this.map.queryRenderedFeatures(e.point, {
  layers: [this.stationsHitboxLayerId]
});
const nearestStation = this.resolveNearestFeature(e, stationFeatures);

const shotFeatures = this.map.queryRenderedFeatures(e.point, {
  layers: [this.shotsHitboxLayerId]
});
const nearestShot = this.resolveNearestFeature(e, shotFeatures);
```

## MapCanvas.tsx Changes

### Box select query

```typescript
const features = map.current.queryRenderedFeatures(box, {
  layers: ['survey-stations-hitbox']  // Was: 'survey-stations'
});
```

### Snap detection

Update `checkSnapToStation()` to use `config.map.snap.*`:

```typescript
// BEFORE:
const threshold = config.snap.threshold_pixels;
if (config.snap.enabled_draw) { ... }

// AFTER:
const threshold = config.map.snap.threshold;
if (config.map.snap.enabledDraw) { ... }
```

## Priority handling

Station hitbox has priority over shot hitbox. The handler order ensures stations are checked first. Additionally, the empty-click handler should:
1. Query stations-hitbox first
2. If hit, don't trigger empty-space behavior
3. Only check shots-hitbox if no station hit
## SurveyLayer.tsx Changes

### initializeEventHandlers() (L405-530)

**Station click** (L407-418):
```typescript
// Before: this.map.on('click', this.stationsLayerId, ...)
// After:
this.map.on('click', this.stationsHitboxLayerId, this.handleStationClick);
```

**Shot click** (L421-434):
```typescript
// Before: this.map.on('click', this.shotsLayerId, ...)
// After:
this.map.on('click', this.shotsHitboxLayerId, this.handleShotClick);
```

**Station hover** (L449-475):
```typescript
// Before: this.map.on('mouseenter', this.stationsLayerId, ...)
// After:
this.map.on('mouseenter', this.stationsHitboxLayerId, this.handleStationEnter);
this.map.on('mouseleave', this.stationsHitboxLayerId, this.handleStationLeave);
```

**Shot hover** (L478-503):
```typescript
// Before: this.map.on('mouseenter', this.shotsLayerId, ...)
// After:
this.map.on('mouseenter', this.shotsHitboxLayerId, this.handleShotEnter);
this.map.on('mouseleave', this.shotsHitboxLayerId, this.handleShotLeave);
```

**Context menu** (L506-528):
```typescript
// Update queryRenderedFeatures to query hitbox layers
const stationFeatures = this.map.queryRenderedFeatures(e.point, {
  layers: [this.stationsHitboxLayerId]  // Was: this.stationsLayerId
});
const shotFeatures = this.map.queryRenderedFeatures(e.point, {
  layers: [this.shotsHitboxLayerId]  // Was: this.shotsLayerId
});
```

**Ghost station events** (if present):
Move from `survey-ghost-stations` to `survey-ghost-stations-hitbox`

### Cursor change

Cursor should change to 'pointer' when hovering hitbox area (not just visual bounds):
```typescript
this.map.on('mouseenter', this.stationsHitboxLayerId, () => {
  this.map.getCanvas().style.cursor = 'pointer';
});
```

## MapCanvas.tsx Changes

### Box select query (L290-292)

```typescript
// Before:
const features = this.map.queryRenderedFeatures(box, {
  layers: ['survey-stations']
});

// After:
const features = map.current.queryRenderedFeatures(box, {
  layers: ['survey-stations-hitbox']
});
```

### Snap detection (L80-133)

Update `checkSnapToStation()` to use `config.map.snap.threshold` instead of `config.snap.threshold_pixels`:
```typescript
// Before: const threshold = config.snap.threshold_pixels;
// After:
const threshold = config.map.snap.threshold;
```

Also update snap enabled checks:
```typescript
// Before: config.snap.enabled_draw
// After: config.map.snap.enabledDraw
```

## Priority handling

When both station and shot hitbox features are at click point, station wins (existing behavior preserved). This is handled by checking station features first in the handler order.
## Changes Required

### Event Registration (SurveyLayer.tsx)

Replace event listeners on visual layers with hitbox layers:

**Before:**
```typescript
this.map.on('click', 'survey-stations', this.handleStationClick);
this.map.on('mouseenter', 'survey-stations', this.handleStationEnter);
```

**After:**
```typescript
this.map.on('click', 'survey-stations-hitbox', this.handleStationClick);
this.map.on('mouseenter', 'survey-stations-hitbox', this.handleStationEnter);
```

### Layers to Update

1. **Station events**: Move from `survey-stations` to `survey-stations-hitbox`
   - click, mouseenter, mouseleave

2. **Shot events**: Move from `survey-shots` to `survey-shots-hitbox`
   - click, mouseenter, mouseleave

3. **Ghost station events**: Move from `survey-ghost-stations` to `survey-ghost-stations-hitbox`

### Query Updates

Update any `queryRenderedFeatures` calls to query hitbox layers:

```typescript
// Before
const features = this.map.queryRenderedFeatures(point, {
  layers: ['survey-stations']
});

// After
const features = this.map.queryRenderedFeatures(point, {
  layers: ['survey-stations-hitbox']
});
```

### Cursor Changes

Cursor should still change to 'pointer' when hovering hitbox layers (not just visual bounds).

### Priority Handling

Station hitbox has priority over shot hitbox (existing behavior preserved). If both station-hitbox and shot-hitbox features are at the click point, station wins.
## Acceptance
- [ ] `resolveNearestFeature()` helper added for nearest-to-click resolution
- [ ] Station click uses hitbox layer AND nearest resolver
- [ ] Shot click uses hitbox layer AND nearest resolver
- [ ] Station hover uses hitbox layer
- [ ] Shot hover uses hitbox layer
- [ ] Global empty-click handler queries hitbox layers (not visual layers)
- [ ] Context menu queries hitbox layers AND uses nearest resolver
- [ ] Box select queries `survey-stations-hitbox`
- [ ] Snap detection uses `config.map.snap.threshold`
- [ ] Snap enabled checks use `config.map.snap.enabledDraw/Merge/Measure`
- [ ] Cursor changes to 'pointer' when hovering hitbox area
- [ ] Station priority over shot preserved
- [ ] `pnpm tsc --noEmit` passes
- [ ] Manual test: overlapping stations select nearest to click
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
