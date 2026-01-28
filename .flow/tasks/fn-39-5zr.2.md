## Goal

Extend the existing `section-highlighting.spec.ts` Playwright tests to verify that section hover/selection actually applies `feature-state` to map features (shots and stations), not just that the store state is correct.

## Context

- `e2e-playwright/section-highlighting.spec.ts` already has comprehensive tests for store state changes (hoveredSectionId, selection state)
- The existing `hasSectionMapHighlight()` helper only checks uiStore state — it does NOT verify that MapLibre `feature-state` is applied to actual map features
- After task fn-39-5zr.1, `updateVisualState()` will set `hover: true` / `selected: true` feature-state on all features in a section
- We need tests that verify the feature-state is actually applied on the map

## Implementation

### 1. Add a helper to check feature-state on map features

Add a helper function that queries MapLibre for features in a section and checks their feature-state:

```typescript
async function getSectionFeatureStates(
  page: Page,
  sectionId: number,
  stateKey: 'hover' | 'selected'
): Promise<{ shots: { total: number; withState: number }; stations: { total: number; withState: number } }> {
  return page.evaluate(({ secId, key }) => {
    const map = (window as any).__cavechef_map__;
    if (!map) return { shots: { total: 0, withState: 0 }, stations: { total: 0, withState: 0 } };

    const checkSource = (sourceName: string) => {
      const features = map.querySourceFeatures(sourceName);
      const sectionFeatures = features.filter((f: any) => f.properties?.sectionId === secId);
      const uniqueIds = new Set(sectionFeatures.map((f: any) => f.properties?.featureId));
      let withState = 0;
      for (const id of uniqueIds) {
        const state = map.getFeatureState({ source: sourceName, id });
        if (state?.[key]) withState++;
      }
      return { total: uniqueIds.size, withState };
    };

    return {
      shots: checkSource('survey-shots'),
      stations: checkSource('survey-stations'),
    };
  }, { secId: sectionId, key: stateKey });
}
```

### 2. Add feature-state verification to existing tests

Extend the following existing test cases to also verify feature-state:

**"hovering section row sets hoveredSectionId and applies map styling"** — after verifying store state, add:
```typescript
// Verify feature-state is applied to map features
const states = await getSectionFeatureStates(page, firstSectionId, 'hover');
expect(states.shots.withState).toBe(states.shots.total);
expect(states.stations.withState).toBe(states.stations.total);
```

**"clicking section row selects section and applies map styling"** — add feature-state check for `selected`.

**"hoveredSectionId clears when mouse leaves section row"** — verify feature-state is removed after unhover.

### 3. Add new test: section selection + different section hover coexist

Add a test verifying both feature-states are visible simultaneously:
- Select section A
- Hover section B
- Verify section A features have `selected: true` feature-state
- Verify section B features have `hover: true` feature-state
- Verify section A features do NOT have `hover: true` (only section B is hovered)

### 4. Add new test: section feature-state clears on Escape

Verify that pressing Escape removes `selected` feature-state from all section features.

## Files changed

- `e2e-playwright/section-highlighting.spec.ts`

## Verification

- `pnpm test:ui` — all new and existing tests pass
- `pnpm tsc --noEmit` passes
