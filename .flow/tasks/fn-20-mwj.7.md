# fn-20-mwj.7 Implement DataTable hover/click/double-click to Map sync

## Description
Implement synchronization from DataTable interactions to Map: row hover highlights shot on map, row click selects shot, double-click pans map to shot midpoint.

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

4. **Double-click → Map pan to shot midpoint**:
   - Add new uiStore action: `triggerPanToShot(sectionId: number, shotId: number)`
   - Add state: `requestPanToShot: { sectionId: number; shotId: number } | null`
   - In MapCanvas, watch for requestPanToShot:
     - Find the shot's from-station and to-station from stations array
     - Calculate shot midpoint: `midpoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }`
     - Convert midpoint to GPS coordinates using existing `projectToGps` utility
     - Call `map.easeTo({ center: [lng, lat] })` to pan to midpoint
   - Clear `requestPanToShot` after handling to avoid repeat pans

## Key context

Memory pitfall: "Hover state across feature types: When clearing hover state for one feature type, only fire onFeatureHover(false) if no other feature type is currently hovered"

Shot geometry: A shot connects two stations. The from-station is at `station_index = shotIndex`, the to-station is at `station_index = shotIndex + 1`.

References:
- uiStore hover state at lines 175-180
- MapCanvas easeTo pattern at lines 1224-1230
- Coordinate conversion utilities at `src/utils/coordinates.ts`

## Acceptance
- [ ] Hovering row in DataTable highlights corresponding shot on map
- [ ] Mouse leave clears hover highlight on map
- [ ] Clicking row selects the shot (Detail Panel updates)
- [ ] Entering cell edit mode selects the shot
- [ ] Double-clicking row pans map to center on shot midpoint (not station)
- [ ] Shot midpoint calculated from from/to station coordinates
- [ ] Map pan uses smooth animation (easeTo)
- [ ] requestPanToShot state cleared after handling
- [ ] No hover flicker when moving between rows
- [ ] Type check passes: `pnpm tsc --noEmit`

## Done summary
Implemented bi-directional hover/click/double-click sync from DataTable to Map: row hover highlights shot on map via uiStore.hoveredShot synced to SurveyLayer, row click selects shot for Detail Panel, double-click pans map to shot midpoint using smooth animation.
## Evidence
- Commits: 12ee44f, 0783d5e17e43a43931b97d8e4215de4d0aef1d54
- Tests: pnpm tsc --noEmit
- PRs: