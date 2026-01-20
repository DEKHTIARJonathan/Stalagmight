# fn-9-d6v.4 Update SurveyLayer.updateVisualState for section highlighting

## Description
Update SurveyLayer.updateVisualState() to include section-level highlighting.

## Files to Modify

### `src/components/Map/SurveyLayer.tsx`

**Refactor updateVisualState() (L533-579) to use expression builder:**

Import at top:
```typescript
import { buildPriorityExpression, featureEquals, inSection } from '@/utils/maplibre-expressions';
```

**Priority order for stations (circle-stroke-width):**
1. snap: 4px
2. individual hover: 3px  
3. **section hover: 3px** (NEW)
4. individual selected: 2px
5. **section selected: 2px** (NEW)
6. normal: 1px

**Implementation:**
```typescript
private updateVisualState() {
  const stationIdExpr = ['concat', ['get', 'sectionId'], ':', ['to-string', ['get', 'stationIndex']]];

  // Station stroke width with section-level priorities
  const stationStrokeWidth = buildPriorityExpression([
    { condition: ['==', stationIdExpr, this.snappedStationId ?? ''], value: 4 },
    { condition: ['==', stationIdExpr, this.hoveredStationId ?? ''], value: 3 },
    { condition: inSection(this.hoveredSectionId), value: 3 },
    { condition: ['==', stationIdExpr, this.selectedStationId ?? ''], value: 2 },
    { condition: inSection(this.selectedSectionId), value: 2 },
  ], 1);
  
  this.map.setPaintProperty(this.stationsLayerId, 'circle-stroke-width', stationStrokeWidth);

  // Station stroke color (same priority order)
  const stationStrokeColor = buildPriorityExpression([
    { condition: ['==', stationIdExpr, this.snappedStationId ?? ''], value: '#00ffcc' },
    { condition: ['==', stationIdExpr, this.selectedStationId ?? ''], value: '#00aaff' },
    { condition: inSection(this.selectedSectionId), value: '#00aaff' },
    { condition: ['==', stationIdExpr, this.hoveredStationId ?? ''], value: '#0066ff' },
    { condition: inSection(this.hoveredSectionId), value: '#0066ff' },
  ], ['get', 'strokeColor']);

  this.map.setPaintProperty(this.stationsLayerId, 'circle-stroke-color', stationStrokeColor);

  // Shot line width with section priorities
  const shotIdExpr = ['concat', ['get', 'sectionId'], ':', ['get', 'shotId']];
  const shotLineWidth = buildPriorityExpression([
    { condition: ['==', shotIdExpr, this.hoveredShotId ?? ''], value: 4 },
    { condition: inSection(this.hoveredSectionId), value: 4 },
    { condition: ['==', shotIdExpr, this.selectedShotId ?? ''], value: 3 },
    { condition: inSection(this.selectedSectionId), value: 3 },
  ], 2);

  this.map.setPaintProperty(this.shotsLayerId, 'line-width', shotLineWidth);
}
```

## Visual Treatment
- Section hover/selection uses SAME visual style as individual hover/selection
- All shots AND stations in section highlight simultaneously
- Virtual shots included (they have same sectionId)
- Merge lines and loop closures NOT affected (separate layers)
## Acceptance
- [ ] Expression builder imported from `@/utils/maplibre-expressions`
- [ ] Station stroke-width expression includes section hover (3px) and section selected (2px)
- [ ] Station stroke-color expression includes section hover (#0066ff) and section selected (#00aaff)
- [ ] Shot line-width expression includes section hover (4px) and section selected (3px)
- [ ] Priority order: snap > individual hover > section hover > individual selected > section selected > normal
- [ ] Features use `['get', 'sectionId']` for section matching
- [ ] Virtual shots highlight (same code path - they have sectionId)
- [ ] Merge lines unchanged
- [ ] Loop closures unchanged
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
