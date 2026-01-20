# fn-9-d6v.2 Create MapLibre expression builder utility

## Description
Create generic MapLibre expression builder utility for priority-based styling.

## New File: `src/utils/maplibre-expressions.ts`

### Core Function
```typescript
import type { Expression } from 'maplibre-gl';

interface PriorityLevel {
  condition: Expression;
  value: number | string;
}

/**
 * Builds a MapLibre case expression with priority-ordered conditions.
 * Higher priority conditions (earlier in array) override lower ones.
 */
export function buildPriorityExpression(
  priorities: PriorityLevel[],
  fallback: number | string
): Expression {
  if (priorities.length === 0) return fallback as any;

  const cases: any[] = ['case'];
  for (const { condition, value } of priorities) {
    cases.push(condition, value);
  }
  cases.push(fallback);

  return cases as Expression;
}

/**
 * Creates an equality condition for feature property matching.
 */
export function featureEquals(
  property: string,
  value: string | null
): Expression {
  return ['==', ['get', property], value ?? ''];
}

/**
 * Creates a section membership condition.
 */
export function inSection(sectionId: string | null): Expression {
  return ['==', ['get', 'sectionId'], sectionId ?? ''];
}
```

### Usage Example
```typescript
// In SurveyLayer.updateVisualState()
const strokeWidth = buildPriorityExpression([
  { condition: featureEquals('id', this.snappedStationId), value: 4 },
  { condition: featureEquals('id', this.hoveredStationId), value: 3 },
  { condition: inSection(this.hoveredSectionId), value: 3 },
  { condition: featureEquals('id', this.selectedStationId), value: 2 },
  { condition: inSection(this.selectedSectionId), value: 2 },
], 1);

this.map.setPaintProperty(this.stationsLayerId, 'circle-stroke-width', strokeWidth);
```

## Why Pure Functions
- Easy to unit test (input → output, no side effects)
- Composable for complex expressions
- Clear separation from MapLibre-specific map manipulation
## Acceptance
- [ ] `src/utils/maplibre-expressions.ts` created
- [ ] `buildPriorityExpression()` function implemented with correct MapLibre case syntax
- [ ] `featureEquals()` helper for property matching
- [ ] `inSection()` helper for section membership check
- [ ] TypeScript types properly defined (Expression from maplibre-gl)
- [ ] Functions are pure (no side effects)
- [ ] Exports available for SurveyLayer to import
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
