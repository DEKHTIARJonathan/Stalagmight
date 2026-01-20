# fn-9-d6v.4 Update SurveyLayer.updateVisualState for section highlighting

## Description
Update SurveyLayer.updateVisualState() to include section-level highlighting with explicit MapLibre expressions.

## Files to Modify

### `src/components/Map/SurveyLayer.tsx`

**Import expression builder at top:**
```typescript
import { buildPriorityExpression, compositeIdEquals, inSection } from '../../utils/maplibre-expressions';
```

**Add private state (near L56-61):**
```typescript
private hoveredSectionId: string | null = null;
private selectedSectionId: string | null = null;
```

**Refactor updateVisualState() (L532-580) with EXPLICIT expressions:**

**Station stroke-width:**
```typescript
const stationStrokeWidth = buildPriorityExpression([
  { condition: compositeIdEquals(['sectionId', 'stationIndex'], this.snappedStationId), value: 4 },
  { condition: compositeIdEquals(['sectionId', 'stationIndex'], this.hoveredStationId), value: 3 },
  { condition: inSection(this.hoveredSectionId), value: 3 },  // SECTION HOVER
  { condition: compositeIdEquals(['sectionId', 'stationIndex'], this.selectedStationId), value: 2 },
  { condition: inSection(this.selectedSectionId), value: 2 },  // SECTION SELECTED
], 1);
this.map.setPaintProperty(this.stationsLayerId, 'circle-stroke-width', stationStrokeWidth);
```

**Station stroke-color:**
```typescript
const stationStrokeColor = buildPriorityExpression([
  { condition: compositeIdEquals(['sectionId', 'stationIndex'], this.snappedStationId), value: '#00ffcc' },
  { condition: compositeIdEquals(['sectionId', 'stationIndex'], this.selectedStationId), value: '#00aaff' },
  { condition: inSection(this.selectedSectionId), value: '#00aaff' },  // SECTION SELECTED
  { condition: compositeIdEquals(['sectionId', 'stationIndex'], this.hoveredStationId), value: '#0066ff' },
  { condition: inSection(this.hoveredSectionId), value: '#0066ff' },  // SECTION HOVER
], '#000000');  // Fallback: black stroke (zero-datum gold FILL is preserved)
this.map.setPaintProperty(this.stationsLayerId, 'circle-stroke-color', stationStrokeColor);
```

**Shot line-width:**
```typescript
const shotLineWidth = buildPriorityExpression([
  { condition: compositeIdEquals(['sectionId', 'shotId'], this.hoveredShotId), value: 4 },
  { condition: inSection(this.hoveredSectionId), value: 4 },  // SECTION HOVER
  { condition: compositeIdEquals(['sectionId', 'shotId'], this.selectedShotId), value: 3 },
  { condition: inSection(this.selectedSectionId), value: 3 },  // SECTION SELECTED
], 2);
this.map.setPaintProperty(this.shotsLayerId, 'line-width', shotLineWidth);
```

## Key Points
- **inSection() handles number→string conversion**: `['to-string', ['get', 'sectionId']]`
- **compositeIdEquals() replaces inline expressions**: Cleaner, testable code
- **Zero-datum gold FILL preserved**: Expression only changes stroke, not fill color (L264)
- **Virtual shots included**: They have sectionId, so inSection() matches them
- **Both stations AND shots updated**: Section highlight applies to all features
## Files to Modify

### `src/components/Map/SurveyLayer.tsx`

**Import expression builder at top:**
```typescript
import { buildPriorityExpression, compositeIdEquals, inSection } from '../../utils/maplibre-expressions';
```

**Refactor updateVisualState() (L532-580):**

**Priority order for stations (circle-stroke-width):**
1. snap: 4px
2. individual hover: 3px  
3. **section hover: 3px** (NEW)
4. individual selected: 2px
5. **section selected: 2px** (NEW)
6. normal: 1px

**Implementation using expression builder:**
```typescript
private updateVisualState() {
  // Station stroke width with section-level priorities
  const stationStrokeWidth = buildPriorityExpression([
    { condition: compositeIdEquals(['sectionId', 'stationIndex'], this.snappedStationId), value: 4 },
    { condition: compositeIdEquals(['sectionId', 'stationIndex'], this.hoveredStationId), value: 3 },
    { condition: inSection(this.hoveredSectionId), value: 3 },  // NEW
    { condition: compositeIdEquals(['sectionId', 'stationIndex'], this.selectedStationId), value: 2 },
    { condition: inSection(this.selectedSectionId), value: 2 },  // NEW
  ], 1);
  
  this.map.setPaintProperty(this.stationsLayerId, 'circle-stroke-width', stationStrokeWidth);

  // Station stroke color (same priority order)
  const stationStrokeColor = buildPriorityExpression([
    { condition: compositeIdEquals(['sectionId', 'stationIndex'], this.snappedStationId), value: '#00ffcc' },
    { condition: compositeIdEquals(['sectionId', 'stationIndex'], this.selectedStationId), value: '#00aaff' },
    { condition: inSection(this.selectedSectionId), value: '#00aaff' },  // NEW
    { condition: compositeIdEquals(['sectionId', 'stationIndex'], this.hoveredStationId), value: '#0066ff' },
    { condition: inSection(this.hoveredSectionId), value: '#0066ff' },  // NEW
  ], ['get', 'strokeColor']);  // Fallback preserves zero-datum gold

  this.map.setPaintProperty(this.stationsLayerId, 'circle-stroke-color', stationStrokeColor);

  // Shot line width with section priorities
  const shotLineWidth = buildPriorityExpression([
    { condition: compositeIdEquals(['sectionId', 'shotId'], this.hoveredShotId), value: 4 },
    { condition: inSection(this.hoveredSectionId), value: 4 },  // NEW
    { condition: compositeIdEquals(['sectionId', 'shotId'], this.selectedShotId), value: 3 },
    { condition: inSection(this.selectedSectionId), value: 3 },  // NEW
  ], 2);

  this.map.setPaintProperty(this.shotsLayerId, 'line-width', shotLineWidth);
}
```

## Key Points
- **inSection() handles type conversion**: sectionId stored as number, converted to string
- **compositeIdEquals() replaces inline expressions**: Cleaner, testable code
- **Zero-datum gold stroke preserved**: Fallback uses `['get', 'strokeColor']`
- **Virtual shots included**: They have sectionId, so inSection() matches them
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
- [ ] Expression builder imported from `../../utils/maplibre-expressions`
- [ ] `hoveredSectionId` and `selectedSectionId` private state added
- [ ] `compositeIdEquals()` replaces inline station/shot ID expressions
- [ ] `inSection()` used for section-level matching (handles number→string conversion)
- [ ] Station stroke-width includes section hover (3px) and section selected (2px)
- [ ] Station stroke-color includes section hover (#0066ff) and section selected (#00aaff)
- [ ] Station stroke-color fallback is `#000000` (black, zero-datum gold FILL preserved separately)
- [ ] Shot line-width includes section hover (4px) and section selected (3px)
- [ ] Priority order: snap > individual hover > section hover > individual selected > section selected > normal
- [ ] Virtual shots highlight (inSection matches their sectionId)
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
