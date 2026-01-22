# fn-20-mwj.7 Implement DataTable hover/click/double-click to Map sync

## Description
Implement synchronization from DataTable interactions to Map: row hover highlights shot on map, row click selects shot, double-click pans map to shot.

**Size:** M
**Files:**
- `src/components/SingleSystemView/DataTable.tsx`
- `src/store/uiStore.ts` (add panToShot action)
- `src/components/Map/MapCanvas.tsx` (handle panToShot)

## Approach

1. **Row hover → Map highlight**:
   - Use new `onRowHover` prop from EditableTable
   - Call `setHoveredShot({ sectionId, shotId })` on hover
   - Call `setHoveredShot(null)` on mouse leave
   - Map already handles `hoveredShot` state for highlighting

2. **Row click → Selection**:
   - Activate the dormant `handleRowClick` (lines 61-69)
   - Wire to new `onRowClick` prop
   - Calls `setSelection({ type: 'shot', sectionId, shotId })`

3. **Cell edit → Selection**:
   - When `handleCellEdit` is called, also set selection for that shot
   - Ensures Detail Panel updates when editing

4. **Double-click → Map pan**:
   - Add new uiStore action: `triggerPanToShot(sectionId: number, shotId: number)`
   - Add state: `requestPanToShot: { sectionId: number; shotId: number } | null`
   - In MapCanvas, watch for requestPanToShot and call `easeTo()` with shot coordinates
   - Get shot coordinates from stations array (station for that shot)

## Key context

Memory pitfall: "Hover state across feature types: When clearing hover state for one feature type, only fire onFeatureHover(false) if no other feature type is currently hovered"

uiStore hover state at lines 175-180:
```tsx
hoveredShot: { sectionId: SectionId; shotId: ShotId } | null;
setHoveredShot: (shot: { sectionId: SectionId; shotId: ShotId } | null) => void;
```

MapCanvas easeTo pattern at lines 1224-1230.
## Acceptance
- [ ] Hovering row in DataTable highlights corresponding shot on map
- [ ] Mouse leave clears hover highlight on map
- [ ] Clicking row selects the shot (Detail Panel updates)
- [ ] Entering cell edit mode selects the shot
- [ ] Double-clicking row pans map to center on that shot
- [ ] Map pan uses smooth animation (easeTo)
- [ ] No hover flicker when moving between rows
- [ ] Type check passes: `pnpm tsc --noEmit`
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
