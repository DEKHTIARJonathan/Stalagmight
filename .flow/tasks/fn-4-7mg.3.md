# fn-4-7mg.3 Update click/hover event handlers to use hitbox layers

## Description
Update event handlers with unified click handler and station priority.

## UNIFIED Click/Contextmenu Handler

**CRITICAL**: Use a single unified click handler that queries both hitbox layers and resolves priority:

1. **Stations take priority over shots** - always check stations first
2. Query both layers, resolve nearest station first
3. If no station hit, resolve nearest shot
4. If neither, treat as empty-click

```typescript
private handleMapClick = (e: MapLayerMouseEvent) => {
  // Query both hitbox layers
  const stationFeatures = this.map.queryRenderedFeatures(e.point, {
    layers: [this.stationsHitboxLayerId]
  });
  const shotFeatures = this.map.queryRenderedFeatures(e.point, {
    layers: [this.shotsHitboxLayerId]
  });

  // Stations take priority
  const nearestStation = this.resolveNearestStation(e, stationFeatures);
  if (nearestStation) {
    this.handleStationSelection(nearestStation, e);
    return;
  }

  // Then shots
  const nearestShot = this.resolveNearestShot(e, shotFeatures);
  if (nearestShot) {
    this.handleShotSelection(nearestShot, e);
    return;
  }

  // Empty click
  this.handleEmptyClick(e);
};
```

Same pattern for `handleContextMenu`.

## Hover: Standard Behavior (No Change)

**Hover uses standard behavior** (mouseenter/mouseleave on hitbox layers). MapLibre gives topmost feature - that's fine for hover since station hitbox layers are stacked above shot hitbox layers.

```typescript
private handleStationEnter = (e: MapLayerMouseEvent) => {
  // Use e.features[0] directly - standard MapLibre behavior
  const feature = e.features?.[0];
  // ...
};
```

## Distance-to-Line-Segment for Shots

```typescript
private distanceToLineSegment(px, py, x1, y1, x2, y2): number {
  const A = px - x1, B = py - y1;
  const C = x2 - x1, D = y2 - y1;
  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = lenSq !== 0 ? dot / lenSq : -1;

  let xx, yy;
  if (param < 0) { xx = x1; yy = y1; }
  else if (param > 1) { xx = x2; yy = y2; }
  else { xx = x1 + param * C; yy = y1 + param * D; }

  return Math.sqrt((px - xx) ** 2 + (py - yy) ** 2);
}
```

## Global Empty-Click Handler

Query hitbox layers (NOT ghost):
```typescript
const stationHits = this.map.queryRenderedFeatures(e.point, {
  layers: [this.stationsHitboxLayerId]
});
const shotHits = this.map.queryRenderedFeatures(e.point, {
  layers: [this.shotsHitboxLayerId]
});
if (stationHits.length === 0 && shotHits.length === 0) {
  // Empty click
}
```
## Distance-to-Line-Segment for Shots

Don't use just endpoint or midpoint distance. Compute perpendicular distance to line segment:

```typescript
private distanceToLineSegment(
  px: number, py: number,  // Click point in screen coords
  x1: number, y1: number,  // Line start in screen coords
  x2: number, y2: number   // Line end in screen coords
): number {
  const A = px - x1;
  const B = py - y1;
  const C = x2 - x1;
  const D = y2 - y1;

  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = lenSq !== 0 ? dot / lenSq : -1;

  let xx, yy;
  if (param < 0) {
    xx = x1; yy = y1;  // Closest to start
  } else if (param > 1) {
    xx = x2; yy = y2;  // Closest to end
  } else {
    xx = x1 + param * C;  // Perpendicular point
    yy = y1 + param * D;
  }

  return Math.sqrt((px - xx) ** 2 + (py - yy) ** 2);
}
```

## Nearest Shot Resolution

```typescript
private resolveNearestShot(
  e: MapLayerMouseEvent,
  features: MapGeoJSONFeature[]
): MapGeoJSONFeature | null {
  if (features.length === 0) return null;
  if (features.length === 1) return features[0];

  let nearest = features[0];
  let nearestDist = Infinity;

  for (const feature of features) {
    const geom = feature.geometry;
    if (geom.type === 'LineString' && geom.coordinates.length >= 2) {
      // Project line endpoints to screen
      const [lng1, lat1] = geom.coordinates[0];
      const [lng2, lat2] = geom.coordinates[1];
      const p1 = this.map.project([lng1, lat1]);
      const p2 = this.map.project([lng2, lat2]);

      const dist = this.distanceToLineSegment(
        e.point.x, e.point.y,
        p1.x, p1.y, p2.x, p2.y
      );

      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = feature;
      }
    }
  }
  return nearest;
}
```

## Global Empty-Click Handler

Update to query hitbox layers:
```typescript
const stationHits = this.map.queryRenderedFeatures(e.point, {
  layers: [this.stationsHitboxLayerId]
});
const shotHits = this.map.queryRenderedFeatures(e.point, {
  layers: [this.shotsHitboxLayerId]
});
if (stationHits.length === 0 && shotHits.length === 0) {
  // Empty space - trigger empty-click behavior
}
```

## Snap Detection Update

```typescript
const threshold = config.map.snap.threshold;
if (config.map.snap.enabled_draw) { ... }
```
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
- [ ] UNIFIED click handler queries both hitbox layers with station priority
- [ ] UNIFIED contextmenu handler queries both hitbox layers with station priority
- [ ] Hover uses standard mouseenter/mouseleave (no nearest) - station hitbox above shot hitbox
- [ ] distanceToLineSegment() for shot selection
- [ ] Ghost layers NOT included in queries
- [ ] Empty-click handled in unified handler when no features hit
- [ ] Snap uses config.map.snap.* (migration)
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
