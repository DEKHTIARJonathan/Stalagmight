# fn-4-7mg.3 Update click/hover event handlers to use hitbox layers

## Description
Update click and hover event handlers in SurveyLayer to use the hitbox layers instead of the visual layers for interaction detection.

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
- [ ] Station click events moved to `survey-stations-hitbox` layer
- [ ] Station hover events moved to `survey-stations-hitbox` layer
- [ ] Shot click events moved to `survey-shots-hitbox` layer
- [ ] Shot hover events moved to `survey-shots-hitbox` layer
- [ ] Ghost layer events moved to ghost hitbox layers
- [ ] queryRenderedFeatures calls updated to use hitbox layers
- [ ] Cursor changes to 'pointer' when hovering hitbox area
- [ ] Station priority over shot preserved
- [ ] `pnpm tsc --noEmit` passes
- [ ] Manual testing: can click station within 10px radius
- [ ] Manual testing: can click shot within 8px width
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
