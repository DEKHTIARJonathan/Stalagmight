# Data Table Panel Improvements

Comprehensive improvements to the Data Table panel including bi-directional selection sync with the map, themed dropdown styling, ID format changes, azimuth simplification, and visual polish.

## Problem

The Data Table panel currently operates somewhat independently from the rest of the application. There's no synchronization between selections made on the map/sections panel and the Data Table, the section dropdown uses unstyled native HTML select, shot IDs display internal database IDs rather than user-friendly formats, and azimuth is split across two columns when a single averaged column would be cleaner.

## Key Decisions

### 1. Bi-directional Selection Sync
- **Data Table follows external selection**: When a shot/station is selected on the map or sections panel, the Data Table:
  - Switches to the correct section (auto-switch dropdown)
  - Highlights the corresponding row
  - Scrolls just enough to make the row visible (minimal scroll, not center)
  - Only syncs if Data Table is already open (no auto-expand)
- **Station selection**: Highlights the shot that ENDS at that station (station index N = end of shot N)
- **Section selection**: Switches dropdown to that section, no row highlighted

### 2. Data Table to Map/Detail Panel Sync
- **Row hover**: Immediately highlights shot on map (using existing hoveredShot state)
- **Row click**: Selects the shot (full selection state, updates Detail Panel too)
- **Cell edit**: Entering edit mode sets the shot as selected
- **Double-click row**: Pans map to center on that shot
- **No auto-pan on hover**: Only double-click triggers map panning

### 3. Section Dropdown Styling
- Replace native `<select>` with themed `<Select>` component from `src/components/common/Select.tsx`
- Use component as-is (no style modifications needed)
- Keep "Section:" label prefix

### 4. ID Format Changes
- **Data Table ID column**: Show `sectionId:shotPosition` format (e.g., "5:3")
  - Section ID: Use internal database ID as-is (not display position)
  - Shot position: 1-indexed position within the section (1st shot = 1)
- **Detail Panel shot ID**: Match Data Table format (sectionId:shotPosition)
- **Warnings panel**: Update to show sectionId:position format for consistency

### 5. Azimuth Simplification
- Replace two columns (Azi In, Azi Out) with single "Azi" column showing circular mean
- **Display**: 1 decimal place (e.g., "123.4°")
- **Circular mean calculation**: Handle wrap-around (350° and 10° averages to 0°, not 180°)
- **Editable**: Yes - editing offsets both azimuth_in and azimuth_out by the delta
  - Example: If avg=50 (in=45, out=55) and user changes to 60, result is in=55, out=65
  - Normalize results to 0-360 range after edit

### 6. Column Width Fixes
- Increase minimum width for "Length (m)" column to prevent text wrapping
- Increase minimum width for "Depth Out" column to prevent text wrapping

### 7. Row Styling
- **Hover**: Subtle background change
- **Selected**: Accent-colored left border indicator
- Hover and selected are visually distinct styles

### 8. Keyboard Navigation Enhancement
- **Enter**: Move to cell below (same column)
- **Shift+Enter**: Move to cell above (same column)
- Stay at boundary when reaching first/last row (no wrap)
- Keep existing: Tab=next cell right, Shift+Tab=next cell left

### 9. Section Switching Behavior
- Manually switching section dropdown clears current selection and selects the new section
- If current section is deleted, auto-switch to first remaining section

### 10. Shot Deletion Handling
- When selected shot is deleted, clear selection (no auto-select adjacent)

## Edge Cases

- **Station selection mapping**: Station index N corresponds to end of shot N (shot N ends at station N)
- **Azimuth wrap-around**: Use circular mean for proper 0°/360° boundary handling
- **Azimuth edit wrap-around**: Normalize results to 0-360 after applying delta
- **Section deletion**: Auto-switch to first remaining section if current section deleted
- **Shot deletion**: Clear selection when selected shot is deleted
- **Empty section**: Show "No shots in this section" message (existing behavior)
- **Data Table collapsed**: Don't auto-expand on selection, just sync state for when opened
- **Cross-section selection**: Auto-switch dropdown to match externally selected shot's section

## Open Questions

- None - all requirements clarified during interview

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
