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
2. Clear features in prev set NOT in new set: `setFeatureState({ source, id }, { hover: false })` — **SKIP if featureId equals the current individual hover featureId for that source** (do not clobber individual hover)
3. Set features in new set NOT in prev set: `setFeatureState({ source, id }, { hover: true })` — SKIP if featureId equals the current individual hover featureId for that source (individual hover has priority)
4. Replace prev set with new set

**CRITICAL (review finding):** The skip-individual-feature guard must apply on BOTH the clear path AND the set path. If section hover clears while an individual feature in that section is being hovered on the map, the clear loop must NOT set `hover: false` on that feature — otherwise it cancels the individual highlight. Concretely: when clearing, skip any featureId matching `newHoveredStationFeatureId` (for stations source) or `newHoveredShotFeatureId` (for shots source). Same logic applies to selection clearing — skip featureIds matching `newSelectedStationFeatureId` / `newSelectedShotFeatureId`.

**Section selection (shots + stations):**
Same pattern with `selected` state and `prevSelectedSection*Ids`. Skip features matching individual selected featureIds on both clear and set paths.

### 4. Priority handling

Paint expressions already use `case` with `hover` before `selected`. Section highlighting reuses the SAME `hover`/`selected` feature-state keys. Section hover clearing is handled by the panel's `onMouseLeave` calling `setHoveredSectionId(null)` — NOT by SurveyLayer's mouse handler. When the user moves the mouse from a panel section row to the map, the panel fires mouse-leave which clears `hoveredSectionId` in the store, which propagates via MapCanvas to `SurveyLayer.setHoveredSection(null)`.

### 5. Re-apply feature-state after data updates (review finding)

`SurveyLayer.update()` calls `setData()` on GeoJSON sources, which resets ALL MapLibre feature-state. But `update()` never re-applies highlights. This is a latent bug for individual highlights too, but section highlights (panel-driven, not re-triggered by mouse) make it visible.

**Fix:** At the end of `update()`, after all `setData()` calls, reset all `prev*` tracking fields and call `updateVisualState()`:

```typescript
// setData() clears all feature-state — reset tracking and re-apply
this.prevHoveredStationFeatureId = null;
this.prevHoveredShotFeatureId = null;
this.prevSelectedStationFeatureId = null;
this.prevSelectedShotFeatureId = null;
this.prevHoveredSectionShotIds = new Set();
this.prevHoveredSectionStationIds = new Set();
this.prevSelectedSectionShotIds = new Set();
this.prevSelectedSectionStationIds = new Set();
this.updateVisualState();
```

**Timing note:** `querySourceFeatures()` reads from MapLibre's internal data. After `setData()`, the source should be immediately available for GeoJSON sources (no tile loading). If empirical testing shows otherwise, defer with `requestAnimationFrame`. Verify this works during implementation.

### 6. Cleanup

`clearAllInteractionState()` already nulls section IDs and calls `updateVisualState()`, which will clear all prev sets.

## Type mismatch

Feature `sectionId` is `number`, stored section IDs are `string | null`. Convert with `Number(sectionIdStr)`.

## Edge cases

- Empty section: no matching features → no-op
- Rapid hover switching: synchronous clear-and-set per call
- Section with one feature: same as individual highlight
- Data update while highlighted: re-applied via step 5

## Files changed

- `src/components/Map/SurveyLayer.tsx`

## Verification

- `pnpm tsc --noEmit` passes
- `pnpm test:ui` passes
