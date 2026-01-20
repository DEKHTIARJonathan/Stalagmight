# fn-9-d6v.3 Add section hover/selection methods to SurveyLayer

## Description
Add section hover/selection methods to SurveyLayer following existing patterns.

## Files to Modify

### `src/components/Map/SurveyLayer.tsx`

**Add private state (near L56-61 where other hover/selection state is):**
```typescript
private hoveredSectionId: string | null = null;  // Stored as STRING
private selectedSectionId: string | null = null;  // Stored as STRING
```

**Add public methods (near L583-598 where other setters are):**
```typescript
/**
 * Set the hovered section for visual highlighting.
 * All shots and stations in this section will show hover styling.
 * @param sectionId - The SectionId (number) to hover, or null to clear
 */
setHoveredSection(sectionId: SectionId | null): void {
  // Convert numeric SectionId to string for consistent comparison
  const stringId = sectionId !== null ? String(sectionId) : null;
  if (this.hoveredSectionId === stringId) return;
  this.hoveredSectionId = stringId;
  this.updateVisualState();
}

/**
 * Set the selected section for visual highlighting.
 * All shots and stations in this section will show selected styling.
 * @param sectionId - The SectionId (number) to select, or null to clear
 */
setSelectedSection(sectionId: SectionId | null): void {
  // Convert numeric SectionId to string for consistent comparison
  const stringId = sectionId !== null ? String(sectionId) : null;
  if (this.selectedSectionId === stringId) return;
  this.selectedSectionId = stringId;
  this.updateVisualState();
}
```

## CRITICAL: Type Conversion
- **uiStore stores `hoveredSectionId` as `SectionId` (number)**
- **SurveyLayer stores it as `string`** (converted in setter)
- **MapLibre expressions use `['to-string', ['get', 'sectionId']]`** to convert feature property
- **Both sides are strings, so `['==', ...]` comparison works**

## Why This Pattern
- Matches existing `setSelectedStation`, `setSelectedShot`, `setHoveredStation` pattern
- Early return optimization if ID hasn't changed
- Automatically triggers `updateVisualState()` to refresh MapLibre paint properties
- String storage matches how existing IDs are stored (e.g., "123:0" for station)
## Files to Modify

### `src/components/Map/SurveyLayer.tsx`

**Add private state (near L56-61 where other hover/selection state is):**
```typescript
private hoveredSectionId: string | null = null;
private selectedSectionId: string | null = null;
```

**Add public methods (near L141-160 where other setters are):**
```typescript
/**
 * Set the hovered section for visual highlighting.
 * All shots and stations in this section will show hover styling.
 */
setHoveredSection(sectionId: string | null): void {
  if (this.hoveredSectionId === sectionId) return;
  this.hoveredSectionId = sectionId;
  this.updateVisualState();
}

/**
 * Set the selected section for visual highlighting.
 * All shots and stations in this section will show selected styling.
 */
setSelectedSection(sectionId: string | null): void {
  if (this.selectedSectionId === sectionId) return;
  this.selectedSectionId = sectionId;
  this.updateVisualState();
}
```

## Why This Pattern
- Matches existing `setSelectedStation`, `setSelectedShot`, `setHoveredStation` pattern
- Early return optimization if ID hasn't changed
- Automatically triggers `updateVisualState()` to refresh MapLibre paint properties
## Acceptance
- [ ] `hoveredSectionId: string | null` private state added (STRING type)
- [ ] `selectedSectionId: string | null` private state added (STRING type)
- [ ] `setHoveredSection(sectionId: SectionId | null)` public method added
- [ ] `setSelectedSection(sectionId: SectionId | null)` public method added
- [ ] Both methods convert numeric SectionId to string via `String(sectionId)`
- [ ] Both methods call `updateVisualState()` on change
- [ ] Both methods have early return if ID unchanged
- [ ] JSDoc comments explain the type conversion
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
