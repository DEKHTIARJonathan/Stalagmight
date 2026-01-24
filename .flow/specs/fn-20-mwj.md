# Data Table Panel Improvements

Comprehensive improvements to the Data Table panel including bi-directional selection sync with the map, themed dropdown styling, ID format changes, azimuth simplification, and visual polish.

## Overview

The Data Table panel currently operates independently from the rest of the application. This epic adds:
- Bi-directional selection sync between DataTable and Map/Sections Panel
- Themed dropdown styling using existing Select component
- User-friendly ID format (sectionId:shotPosition instead of internal IDs)
- Single azimuth column with circular mean calculation
- Row hover/selection styling
- Enhanced keyboard navigation (Enter/Shift+Enter)
- Proper edge case handling for deletions
- Screen reader support

## Scope

**In scope:**
- DataTable.tsx component enhancements
- EditableTable.tsx enhancements (row interactions, scroll, keyboard nav)
- DetailPanel.tsx ID format updates
- Shared utility extraction (circularMeanDegrees, formatShotId)
- Column width fixes
- ARIA announcements

**Out of scope:**
- Backend changes
- New database fields
- Export functionality changes

## Approach

### Key Patterns to Follow

1. **Selection state** - Use existing `uiStore.selection`, `hoveredShot` states
   - Pattern at `src/store/uiStore.ts:56-99`
   
2. **Row styling** - Follow SectionsPanel pattern
   - Pattern at `src/components/SingleSystemView/SectionsPanel.tsx:218-219`
   - `isSelected || hoveredSectionId === section.id ? 'bg-accent/20' : 'hover:bg-accent/20'`

3. **Map panning** - Use existing fitToSection/easeTo patterns
   - Pattern at `src/components/Map/MapCanvas.tsx:1186-1297`
   
4. **Circular mean** - Reuse existing function
   - Located at `src/components/Dialogs/SectionPreview.tsx:24-36`
   - Extract to shared utils

5. **Themed Select** - Use existing component as-is
   - Located at `src/components/common/Select.tsx`

### Technical Notes

- **Shot position**: Calculate as `shots.findIndex(s => s.id === shotId) + 1` (1-indexed)
- **Virtual shots**: Include in position count (matches visual display order)
- **Azimuth edit delta**: `newValue - oldMean` applied to both in/out, then normalize 0-360
- **Scroll behavior**: Use `scrollIntoView({ block: 'nearest' })` for minimal scroll
- **Edit focus on Enter**: Move focus to same column in next row, auto-enter edit mode

### Dependencies (from epic-scout)

- fn-3-e6v (Display Toggle Visibility) - establishes showShots state
- fn-9-d6v (Section Hover/Selection) - establishes selection sync patterns
- fn-4-7mg (Interaction hitboxes) - clickable shot layers on map
- fn-8-4v9 (Disable pan/zoom interactions) - guards in useMapTools.ts

## Quick commands

```bash
# Run Playwright tests for DataTable
pnpm test:ui --grep "data-table"

# Run type check
pnpm tsc --noEmit

# Run dev server to test manually
./scripts/dev.sh
```

## Risks

| Risk | Mitigation |
|------|------------|
| Infinite re-render loops from selection sync | Use derived state, not synced state; use useEffect guards |
| Stale closures in event handlers | Use refs for values needed in callbacks |
| EditableTable breaking changes | Keep existing API, add optional new props |
| Azimuth wrap-around bugs | Use proven circularMean algorithm with normalize |

## Acceptance

- [ ] Selecting shot/station on map switches Data Table to correct section and highlights row
- [ ] Selecting section in Sections Panel switches Data Table dropdown
- [ ] Hovering row in Data Table highlights shot on map immediately
- [ ] Clicking row in Data Table selects shot (appears in Detail Panel)
- [ ] Double-clicking row pans map to center on that shot
- [ ] Section dropdown uses themed Select component
- [ ] ID column shows sectionId:shotPosition format (1-indexed shot position)
- [ ] Detail Panel shot ID matches Data Table format
- [ ] Warnings panel shows sectionId:position format
- [ ] Single "Azi" column with circular mean replaces Azi In/Azi Out
- [ ] Editing Azi offsets both underlying values preserving deviation
- [ ] Length and Depth Out columns don't wrap text
- [ ] Hover row has subtle background, selected row has accent left border
- [ ] Enter/Shift+Enter navigate up/down staying in same column
- [ ] Section deletion switches to first remaining section
- [ ] Shot deletion clears selection
- [ ] Screen reader announces row selection changes

## References

- DataTable component: `src/components/SingleSystemView/DataTable.tsx`
- EditableTable component: `src/components/common/Table.tsx:104-217`
- DetailPanel component: `src/components/SingleSystemView/DetailPanel.tsx`
- Select component: `src/components/common/Select.tsx`
- UI Store selection: `src/store/uiStore.ts:56-99`
- Circular mean function: `src/components/Dialogs/SectionPreview.tsx:24-36`
- Row styling pattern: `src/components/SingleSystemView/SectionsPanel.tsx:218-219`
- Map pan pattern: `src/components/Map/MapCanvas.tsx:1186-1297`

## Documentation Updates Needed

- docs/SPEC.md Section 6: Add Data Table Panel specifics
- docs/TESTING.md Section 15.4: Add DataTable test identifiers
- docs/TESTING.md Section 11.2: Add DataTable keyboard navigation
- docs/architecture.md: Add selection sync pattern documentation
