# fn-4-7mg.2 Add transparent hitbox layers to SurveyLayer

## Description
Add hitbox layers to SurveyLayer with configurable sizes from config.

## CRITICAL: Opacity Must Be Non-Zero

Use `opacity: 0.001` (not 0) to ensure `queryRenderedFeatures` works. Fully transparent layers may not be "rendered" in some MapLibre paths.

## Implementation in SurveyLayer.tsx

### Add new layer ID properties

```typescript
private stationsHitboxLayerId = 'survey-stations-hitbox';
private shotsHitboxLayerId = 'survey-shots-hitbox';
private ghostStationsHitboxLayerId = 'survey-ghost-stations-hitbox';
private ghostShotsHitboxLayerId = 'survey-ghost-shots-hitbox';
```

### Add config storage and method

```typescript
private config: Config | null = null;

public setConfig(config: Config): void {
  this.config = config;
  this.updateHitboxLayers();
  this.updateDebugVisualization();
  this.updateVisualLayerSizes();  // NEW: update visual layers from config
}
```

### Add hitbox layers in initializeLayers()

**Station hitbox layer** (add FIRST, before all other survey layers):
```typescript
this.map.addLayer({
  id: this.stationsHitboxLayerId,
  type: 'circle',
  source: this.stationsSourceId,
  paint: {
    'circle-radius': this.config?.map.station.hitArea ?? 10,
    'circle-color': 'rgba(0, 0, 0, 0)',  // Transparent color
    'circle-opacity': 0.001,  // CRITICAL: non-zero for queryRenderedFeatures
    'circle-stroke-width': 0,
  },
});
```

**Shot hitbox layer:**
```typescript
this.map.addLayer({
  id: this.shotsHitboxLayerId,
  type: 'line',
  source: this.shotsSourceId,
  paint: {
    'line-width': this.config?.map.shot.hitArea ?? 8,
    'line-color': 'rgba(0, 0, 0, 0)',  // Transparent color
    'line-opacity': 0.001,  // CRITICAL: non-zero
    'line-cap': 'round',
  },
});
```

### Layer order (FIRST to LAST)

1. `survey-stations-hitbox` (NEW - this becomes first survey layer)
2. `survey-shots-hitbox` (NEW)
3. `survey-ghost-stations-hitbox` (NEW)
4. `survey-ghost-shots-hitbox` (NEW)
5. `survey-merges`
6. `survey-loop-closures`
7. `survey-shots`
8. ... rest of visual layers
9. Labels

### CRITICAL: Update satellite layer insertion

In MapCanvas.tsx, satellite layer insertion uses "before" parameter to insert below survey layers. Currently anchors on `survey-ghost-shots`. **Must change to `survey-stations-hitbox`** (the new first survey layer).

Find: `this.map.addLayer(satelliteLayer, 'survey-ghost-shots')`
Change to: `this.map.addLayer(satelliteLayer, 'survey-stations-hitbox')`

### Refactor updateVisualState() to use config

Current `updateVisualState()` hardcodes:
- `circle-radius`: 4, 8, 7 (normal, zero-datum, snapped)
- `line-width`: 2, 3, 4 (normal, selected, hovered)

Refactor to use config as base:
```typescript
const baseRadius = this.config?.map.station.radius ?? 4;
const baseWidth = this.config?.map.shot.width ?? 2;

// Apply deltas/multipliers for states
['case',
  ['==', stationIdExpr, this.snappedStationId ?? ''],
  baseRadius + 3,  // Snapped: base + 3
  ['==', ['get', 'isZeroDatum'], true],
  baseRadius + 4,  // Zero datum: base + 4
  baseRadius  // Normal
]
```

### Add updateVisualLayerSizes() method

```typescript
private updateVisualLayerSizes(): void {
  if (!this.map || !this.config) return;

  const stationRadius = this.config.map.station.radius;
  const shotWidth = this.config.map.shot.width;

  // Update visual layer base sizes (updateVisualState will apply state deltas)
  this.updateVisualState();
}
```

## MapCanvas.tsx integration

1. Call `surveyLayerRef.current.setConfig(config)` on init
2. Add useEffect to call `setConfig()` when config changes
3. **CRITICAL**: Update satellite insertion anchor to `survey-stations-hitbox`
## Implementation in SurveyLayer.tsx

### Add new layer ID properties (around L41-72)

```typescript
private stationsHitboxLayerId = 'survey-stations-hitbox';
private shotsHitboxLayerId = 'survey-shots-hitbox';
private ghostStationsHitboxLayerId = 'survey-ghost-stations-hitbox';
private ghostShotsHitboxLayerId = 'survey-ghost-shots-hitbox';
```

### Add config storage and method

```typescript
private config: Config | null = null;

public setConfig(config: Config): void {
  this.config = config;
  this.updateHitboxLayers();
  this.updateDebugVisualization();
}
```

### Add hitbox layers in initializeLayers() (after L168, before visual layers)

**Station hitbox layer:**
```typescript
this.map.addLayer({
  id: this.stationsHitboxLayerId,
  type: 'circle',
  source: this.stationsSourceId,
  paint: {
    'circle-radius': this.config?.map.station.hitArea ?? 10,
    'circle-color': 'rgba(0, 0, 0, 0)',  // Fully transparent
    'circle-stroke-width': 0,
  },
});
```

**Shot hitbox layer:**
```typescript
this.map.addLayer({
  id: this.shotsHitboxLayerId,
  type: 'line',
  source: this.shotsSourceId,
  paint: {
    'line-width': this.config?.map.shot.hitArea ?? 8,
    'line-color': 'rgba(0, 0, 0, 0)',  // Fully transparent
    'line-cap': 'round',  // Better endpoint detection
  },
});
```

**Ghost hitbox layers** (same pattern for merge preview):
- `survey-ghost-stations-hitbox`
- `survey-ghost-shots-hitbox`

### Layer order (bottom to top)

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
11. Labels (existing)

### Add updateHitboxLayers() method

```typescript
private updateHitboxLayers(): void {
  if (!this.map || !this.config) return;

  const stationHitArea = this.config.map.station.hitArea;
  const shotHitArea = this.config.map.shot.hitArea;

  this.map.setPaintProperty(this.stationsHitboxLayerId, 'circle-radius', stationHitArea);
  this.map.setPaintProperty(this.shotsHitboxLayerId, 'line-width', shotHitArea);
  this.map.setPaintProperty(this.ghostStationsHitboxLayerId, 'circle-radius', stationHitArea);
  this.map.setPaintProperty(this.ghostShotsHitboxLayerId, 'line-width', shotHitArea);
}
```

### Update visual layers to use config

Update visual layer paint properties to use `config.map.station.radius` and `config.map.shot.width` instead of hardcoded values.

## MapCanvas.tsx integration

In MapCanvas.tsx, call `surveyLayerRef.current.setConfig(config)` when:
1. SurveyLayer is first initialized (around L448-456)
2. Config changes (add useEffect watching config)
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
- [ ] SurveyLayer has `config` property and `setConfig(config)` method
- [ ] `survey-stations-hitbox` layer uses `opacity: 0.001` (not 0)
- [ ] `survey-shots-hitbox` layer uses `opacity: 0.001` (not 0)
- [ ] Ghost hitbox layers use `opacity: 0.001`
- [ ] Hitbox layers are FIRST in survey layer order
- [ ] Satellite layer insertion anchors on `survey-stations-hitbox` (updated from `survey-ghost-shots`)
- [ ] `updateVisualState()` refactored to use `config.map.station.radius` as base
- [ ] `updateVisualState()` refactored to use `config.map.shot.width` as base
- [ ] State deltas (hover, selected, snapped) applied to config base values
- [ ] MapCanvas calls `setConfig()` on SurveyLayer initialization
- [ ] MapCanvas calls `setConfig()` when config changes (useEffect)
- [ ] `pnpm tsc --noEmit` passes
- [ ] Existing satellite layer order E2E tests still pass
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
