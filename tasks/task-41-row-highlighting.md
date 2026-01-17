# Task 41: Data Table Row Highlighting

## Overview
Synchronize selection between map and data table. When a station is selected on the map, highlight the corresponding row in the data table and vice versa.

## Priority
Medium - Phase C (Data Table)

## Risk Level
Low-Medium

## Dependencies
- Existing selection system in uiStore

## Files to Modify
- `src/components/SingleSystemView/DataTable.tsx` - Row highlighting
- `src/components/common/Table.tsx` - Highlight styles
- `src/store/uiStore.ts` - Selection state sync

## Specifications

### Map → Table Direction
- When station selected on map:
  - Highlight corresponding row(s) in table
  - Auto-scroll table to show row (if hidden)
  - Configurable: center-on-click option

### Table → Map Direction
- When row clicked in table:
  - Select corresponding station on map
  - Optionally center map on station (configurable)

### Highlight Style
- Background color tint (not border)
- Use section color at low opacity
- Clear when selection cleared

### Auto-scroll Behavior
- Only scroll if row not visible
- Configurable in settings
- Smooth scroll animation

### Center on Click
- Configurable option
- Default: enabled
- When disabled: select but don't pan

### Multiple Selection
- Multi-select on map highlights multiple rows
- Multi-select in table highlights multiple stations

### Sticky Header
- Table header always visible when scrolling
- Highlighted row visible below header

## Acceptance Criteria
- [ ] Map selection highlights table row
- [ ] Table click selects map station
- [ ] Auto-scroll works when row hidden
- [ ] Center-on-click is configurable
- [ ] Multi-selection syncs correctly
- [ ] Sticky header works
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Playwright Tests (Mocked IPC)
1. Test clicking station on map highlights table row
2. Test clicking row in table selects station on map
3. Test highlight uses section color tint
4. Test auto-scroll brings hidden row into view
5. Test auto-scroll does not scroll visible rows
6. Test multi-select on map highlights multiple rows
7. Test multi-select in table selects multiple stations
8. Test clearing selection clears highlight
9. Test sticky header stays visible during scroll

### WebdriverIO Tests (Full App)
1. Test map-to-table sync with real data
2. Test table-to-map sync with real data
3. Test center-on-click configurable setting
4. Test auto-scroll configurable setting
5. Test highlight survives panel resize

## Edge Cases
- Station with no corresponding row (virtual?)
- Row for station not on current map view
- Rapid selection changes
- Selection during scroll animation
