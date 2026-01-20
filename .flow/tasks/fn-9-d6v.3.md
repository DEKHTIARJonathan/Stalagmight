# fn-9-d6v.3 Add section hover/selection methods to SurveyLayer

## Description
Add section hover/selection methods to SurveyLayer following existing patterns.

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
- [ ] `hoveredSectionId: string | null` private state added
- [ ] `selectedSectionId: string | null` private state added
- [ ] `setHoveredSection(sectionId)` public method added
- [ ] `setSelectedSection(sectionId)` public method added
- [ ] Both methods call `updateVisualState()` on change
- [ ] Both methods have early return if ID unchanged
- [ ] Methods follow existing naming/style patterns
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
