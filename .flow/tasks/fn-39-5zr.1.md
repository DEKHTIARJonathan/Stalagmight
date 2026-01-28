## Goal

Implement the missing section-level highlighting logic in `SurveyLayer.updateVisualState()` so that hovering or selecting a section in the UI highlights all shots and stations belonging to that section on the map.

## Context

- `SurveyLayer.tsx` already has `hoveredSectionId` and `selectedSectionId` stored as `string | null` (lines 91-92)
- `setHoveredSection()` (line 1175) and `setSelectedSection()` (line 1216) already convert `SectionId` (number) to string and call `updateVisualState()`
- `MapCanvas.tsx` already syncs both hover (line 713) and selection (line 695) to SurveyLayer
- The existing `updateVisualState()` (line 951-1034) handles individual feature hover/selection but has NO section handling
- Features have `sectionId` (number) and `featureId` (number) in their GeoJSON properties
- Sources use `promoteId: 'featureId'` so `setFeatureState()` takes numeric featureId
- The `featureId` encoding: `section.id * 100000 + shot.id` for shots, `section_id * 100000 + station_index` for stations

## Implementation

### 1. Add tracking fields (after line 120)

Add four new `Set<number>` fields to track which feature IDs have section-level state applied per source:

```typescript
private prevHoveredSectionShotIds: Set<number> = new Set();
private prevHoveredSectionStationIds: Set<number> = new Set();
private prevSelectedSectionShotIds: Set<number> = new Set();
private prevSelectedSectionStationIds: Set<number> = new Set();
```

### 2. Add helper to collect section feature IDs

Add a private method using `querySourceFeatures()`:

```typescript
private getSectionFeatureIds(source: string, sectionIdStr: string): Set<number> {
  const features = this.map.querySourceFeatures(source);
  const sectionIdNum = Number(sectionIdStr);
  const ids = new Set<number>();
  for (const f of features) {
    if (f.properties?.sectionId === sectionIdNum && f.properties?.featureId != null) {
      ids.add(f.properties.featureId as number);
    }
  }
  return ids;
}
```

Note: `querySourceFeatures()` returns all features in the source (not just rendered). Use `Set` to deduplicate since tiled sources may return duplicates.

### 3. Extend updateVisualState()

After the existing shot selection block (after line 1033), add section hover and section selection handling.

**Section hover (shots + stations):**
For each source (shots source → prevHoveredSectionShotIds, stations source → prevHoveredSectionStationIds):
1. Compute newIds: if `hoveredSectionId` is not null, call `getSectionFeatureIds(source, hoveredSectionId)`, else empty set
2. Clear features in prev set NOT in new set: `setFeatureState({ source, id }, { hover: false })`
3. Set features in new set NOT in prev set: `setFeatureState({ source, id }, { hover: true })` — SKIP if featureId equals the current individual hover featureId for that source (individual hover has priority)
4. Replace prev set with new set

**Section selection (shots + stations):**
Same pattern with `selected` state and `prevSelectedSection*Ids`. Skip features matching individual selected featureIds.

### 4. Priority handling

Paint expressions already use `case` with `hover` before `selected`. Section highlighting reuses the SAME `hover`/`selected` feature-state keys. Individual hover clears section hover (per spec — they don't coexist). Section selection and individual hover CAN coexist.

### 5. Cleanup

`clearAllInteractionState()` already nulls section IDs and calls `updateVisualState()`, which will clear all prev sets.

## Type mismatch

Feature `sectionId` is `number`, stored section IDs are `string | null`. Convert with `Number(sectionIdStr)`.

## Edge cases

- Empty section: no matching features → no-op
- Rapid hover switching: synchronous clear-and-set per call
- Section with one feature: same as individual highlight

## Files changed

- `src/components/Map/SurveyLayer.tsx`

## Verification

- `pnpm tsc --noEmit` passes
- `pnpm test:ui` passes
