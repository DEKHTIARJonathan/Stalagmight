# Bugfix: Depth Gradient Display Not Working

## Problem

The "Display → Depth Gradient" toggle exists in the UI but does nothing. When enabled, stations and shots continue to display section-based colors instead of depth-based colors. The toggle state persists correctly, but the actual rendering logic to apply depth colors was never implemented.

**Root cause**: MapCanvas doesn't pass `showDepthGradient` to SurveyLayer, and SurveyLayer always uses section colors without any conditional logic for depth mode.

## Scope

**In Scope (this epic):**
- Wire toggle to SurveyLayer
- Implement depth-based coloring for stations/shots/labels
- Add depth legend component
- Unit and E2E tests

**Deferred to separate epics:**
- Export color mode option (requires backend SVG/PDF architecture changes)
- Keyboard shortcuts (requires wiring config.shortcuts to useKeyboardShortcuts)
- Measurement unit support (currently hardcoded to meters throughout app)

## Approach

### 1. Wire toggle via MapCanvas effect dependency
Add `showDepthGradient` and depth range to existing MapCanvas update effect (use actual variable names):
```typescript
// In MapCanvas, extend existing survey data effect (around L580)
useEffect(() => {
  if (!surveyLayerRef.current || !project) return;
  surveyLayerRef.current.update(
    project.sections,
    stations,  // Actual var name
    project.station_merges,
    project.loop_closures,
    gpsOrigin,
    showDepthGradient,  // NEW
    { min: stats?.min_depth ?? 0, max: stats?.max_depth ?? 50 }  // NEW
  );
}, [project, stations, gpsOrigin, showDepthGradient, stats?.min_depth, stats?.max_depth, mapLoaded]);
```

### 2. Extend SurveyLayer.update() signature
Add depth mode parameters to existing update() method (L704):
```typescript
update(
  sections: Section[],
  stations: Station[],
  stationMerges?: StationMerge[],
  loopClosures?: LoopClosure[],
  gpsOrigin?: GpsOrigin | null,
  showDepthGradient: boolean = false,  // NEW
  depthRange: { min: number; max: number } = { min: 0, max: 50 }  // NEW
): void
```

### 3. Modify color computation with null-coalescing
**Station features (L770-790):**
```typescript
const depthColor = showDepthGradient
  ? getDepthColor(station.coordinates.z, '#00bfff', '#ff4444', depthRange.min, depthRange.max)
  : null;
const color = depthColor ?? (section?.color ?? '#ffffff');
```

**Shot features (L723-740):**
```typescript
const avgDepth = (fromStation.coordinates.z + toStation.coordinates.z) / 2;
const depthColor = showDepthGradient
  ? getDepthColor(avgDepth, '#00bfff', '#ff4444', depthRange.min, depthRange.max)
  : null;
const color = depthColor ?? section.color;
```

### 4. Update ALL label layer paints for dynamic color
**Both station labels AND shot labels** currently use hardcoded `text-color: '#ffffff'`.
Modify both layer paints in initializeLayers():
```typescript
// survey-station-labels AND survey-shot-labels paint
paint: {
  'text-color': ['get', 'color'],  // Was: '#ffffff'
  'text-halo-color': '#000000',
  'text-halo-width': 2,  // Increase for readability
  ...
}
```
Add `color` property to both label feature types in update().

### 5. Update getDepthColor() for HSL interpolation + null return
Modify `src/utils/colors.ts:L52-68`:
- Use HSL interpolation (shortest hue path) instead of RGB
- Return `null` for invalid input (NaN, division by zero)
- Caller uses `depthColor ?? sectionColor` fallback

### 6. Zero datum styling with updateVisualState fix
In depth mode: gold stroke (not fill) with depth-colored fill.
**Critical**: Update `updateVisualState()` fallback to use `['get', 'strokeColor']` instead of hardcoded `#000000`, so gold stroke persists for zero-datum stations when not hovered/selected.

### 7. Add DepthLegend component with test IDs
New file: `src/components/Map/DepthLegend.tsx`
- Position: absolute, above scale bar
- Format: vertical SVG gradient (16×80px)
- Test IDs: `data-testid="depth-legend"`, `data-testid="depth-legend-min"`, `data-testid="depth-legend-max"`
- Accessibility: `role="img"` and `aria-label`
- Hidden when toggle OFF
- Single-depth case: solid color, shows "(Flat)" text

### 8. Unchanged elements
- Loop closures: keep error-severity coloring
- Merges: keep distinct styling
- Ghost previews: keep ghost styling
- Selection/hover highlights: unaffected (only override when active)

## Edge Cases

| Case | Handling |
|------|----------|
| All z=0 | All get shallow color, legend shows "0.0m (Flat)" |
| min === max | getDepthColor returns shallow color |
| z < min | Clamp to shallow color |
| z > max | Clamp to deep color |
| NaN/undefined z | getDepthColor returns null, caller uses section color |
| stats not loaded | depthRange defaults to {min:0, max:50} |

## Quick commands
```bash
# Type check
pnpm tsc --noEmit

# Unit tests
pnpm test

# Playwright tests
pnpm test:ui
```

## Acceptance Criteria

- [ ] Toggling "Depth Gradient" ON colors stations/shots by depth using HSL interpolation
- [ ] Station labels AND shot labels use depth color when enabled
- [ ] All color assignments use `depthColor ?? sectionColor` pattern (no null to MapLibre)
- [ ] Toggling OFF instantly reverts to section colors
- [ ] Zero datum stations have gold stroke with depth-colored fill when enabled
- [ ] `updateVisualState()` fallback uses `['get','strokeColor']` not hardcoded black
- [ ] Loop closures and merges keep their distinct styling
- [ ] Depth legend appears above scale bar when enabled, hidden when disabled
- [ ] Legend has test IDs for E2E testing
- [ ] Legend shows min/max depth in meters
- [ ] Single-depth projects show "(Flat)" indicator
- [ ] Unit tests for getDepthColor() including null returns
- [ ] Playwright tests for toggle behavior and legend visibility
- [ ] `pnpm tsc --noEmit` passes
- [ ] All existing tests pass

## Future Work (separate epics)

1. **Export color mode**: Requires deciding backend vs frontend export architecture
2. **Keyboard shortcuts**: Requires wiring config.shortcuts → useKeyboardShortcuts
3. **Measurement units**: Requires centralizing unit conversion throughout app
4. **Colorblind-safe palette**: Alternative to blue-red gradient

## References

### Key Files
- `src/store/uiStore.ts:L152,L226,L358` - showDepthGradient toggle
- `src/components/Map/MapCanvas.tsx:L580` - Survey data update effect
- `src/components/Map/SurveyLayer.tsx:L704` - update() method
- `src/components/Map/SurveyLayer.tsx:L256-270` - Zero datum paint
- `src/components/Map/SurveyLayer.tsx:L372` - Station labels paint
- `src/utils/colors.ts:L52-68` - getDepthColor()

### Depth Convention
- z=0: surface/shallow reference
- z>0: deeper (larger = deeper underwater)
- min_depth: shallowest station z value
- max_depth: deepest station z value
