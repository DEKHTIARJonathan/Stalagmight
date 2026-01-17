# Task 17: Add GPS-based map to GlobalView

## Overview
Show cave systems positioned by GPS coordinates on a satellite map in GlobalView. Systems without GPS fall back to a separate card/list view.

## Priority
Medium - Phase 4 (GlobalView Enhancements)

## Risk Level
Medium

## Dependencies
- Task 16: Enrich ProjectMetadata with GPS info (provides GPS data)

## Files to Modify
- `src/components/GlobalView/GlobalView.tsx` - Add tabs and map container
- `src/components/GlobalView/GlobalViewMap.tsx` - New map component

## Specifications

### View Scope
- Show ALL projects (recent + all discovered)
- Not just recent projects

### View Tabs
- Map tab: Shows GPS-positioned systems
- List tab: Shows all systems (including those without GPS)

### Map Display
- MapLibre with satellite imagery
- Systems rendered as full cave shapes (not just markers)
- Whole system clickable (not just entrance)

### System Markers
- Render complete system shape at GPS position
- Scale appropriately for zoom level
- Use section colors

### Default Zoom
- Fit all systems in view
- Maximum 500km x 500km if systems spread globally

### No Clustering
- Show all systems individually
- No marker clustering in v1

### Interaction
- Click system: Select and show in metadata panel
- Double-click: Open in SingleSystemView

### UI Requirements
- Tab buttons for Map/List view
- Map fills available space
- Add `data-testid` attributes:
  - `globalview-map-tab`
  - `globalview-list-tab`
  - `globalview-map`
  - `system-marker-{projectId}`

## Acceptance Criteria
- [ ] Map tab shows GPS-positioned systems
- [ ] List tab shows all systems
- [ ] Systems rendered at correct GPS positions
- [ ] Full system shape displayed (not just marker)
- [ ] Click selects system
- [ ] Double-click opens system
- [ ] Systems without GPS only in List tab
- [ ] Satellite imagery visible
- [ ] Fits all systems in view by default
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Playwright tests pass

## Test Requirements

### Playwright Tests (e2e-playwright/)
- Test map tab visible
- Test list tab visible
- Test switching between tabs
- Test system appears on map at GPS position
- Test click selects system
- Test double-click opens system
- Test systems without GPS in list only

## Edge Cases
- No systems with GPS
- Single system with GPS
- Systems on opposite sides of world
- Very close systems (overlap)
- Empty project list

## Implementation Notes
- Reuse MapLibre setup from SingleSystemView
- May need simplified rendering for overview
- Consider performance with many projects
- GPS positions from Task 16 metadata
