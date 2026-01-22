# Details Panel Hyperlinks and Center Button

Add interactive hyperlinks throughout the Detail Panel to enable quick navigation between related survey elements (shots, stations, sections), plus a "center on map" button in each detail header.

## Problem

The Detail Panel currently displays relationships between survey elements as static text (e.g., section names, station IDs), requiring users to manually locate and click on related elements in the map or Sections Panel. This breaks the workflow for exploring connected data and makes it harder to trace survey paths or understand section topology.

## Key Decisions

### 1. Hyperlink Scope and Format

**Shot Detail - Connected Section:**
- Start Station: `section_id:station_position` (1-indexed) - links to station
- End Station: `section_id:station_position` (1-indexed) - links to station
- Section: `section_id: section_name` or `section_id: Unnamed` - links to section
- Location: New bordered section labeled "Connected" after LRUD section

**Station Detail - Connected Section:**
- Previous Shot: `section_id:shot_position` (1-indexed) - links to shot (hidden for first station)
- Next Shot: `section_id:shot_position` (1-indexed) - links to shot (hidden for last station)
- Section: `section_id: section_name` or `section_id: Unnamed` - links to section
- Merged With: Existing list becomes clickable hyperlinks
- Location: New bordered section labeled "Connected" before Edit button

**Section Detail - Endpoints Section:**
- First Station: `section_id:station_position` (1-indexed) - links to station
- Last Station: `section_id:station_position` (1-indexed) - links to station
- If section has only 1 station: Show "Only Station: X:Y" instead
- Location: New bordered section labeled "Endpoints"

### 2. ID Format

- All IDs use the same format established in fn-20-mwj: `sectionId:position` where position is 1-indexed
- Section ID uses the database ID (not display index)
- Station position = station_index + 1
- Shot position = shot array index + 1

### 3. Hyperlink Visual Style

- Accent color + underline (classic link style)
- Same style for all link types (station, shot, section)
- Browser default hover effect only (cursor change)
- No additional click feedback (selection change is immediate)

### 4. Click Behavior

- Selection changes to the clicked element type
- Detail Panel updates to show clicked element
- No map pan/zoom on link click
- Section links highlight the section in Sections Panel

### 5. Keyboard Accessibility

- Full keyboard support: Tab to focus, Enter to activate
- Standard focus behavior (no trap)
- Use app's standard focus ring styling
- aria-label describes action: "Select station 2:5", "Select shot 2:3", "Select section 2: Main Passage"
- ARIA live region announces selection changes

### 6. Reusable Component

- Create `DetailLink` component in `src/components/common/DetailLink.tsx`
- Props: type (station|shot|section), id/ref, optional displayText
- Handles selection logic, styling, accessibility internally

### 7. Error Handling

- If link target doesn't exist (data inconsistency): Show link with warning indicator
- Use primary section for merged stations; other sections accessible via merged stations hyperlinks

### 8. Center on Map Button

- Icon: Crosshairs (⌖)
- Position: Far right of Panel title row
- Style: Small/subtle, solid background
- Behavior: Pan + zoom to fit the element
- Visible for: Shot, Station, Section (not Project Stats)
- Tooltip: "Center map on [shot/station/section] X:Y"
- Full keyboard accessibility
- data-testid: `center-shot-button`, `center-station-button`, `center-section-button`
- aria-label: Dynamic based on element type and ID

### 9. Panel Component Extension

- Add optional `rightAction` prop to Panel component
- rightAction accepts ReactNode for action button(s)
- Title stays left-aligned, action pushed to far right

### 10. Dependencies

- Depends on fn-20-mwj (Data Table Improvements) for consistent ID format
- Should be implemented after fn-20-mwj is complete

## Edge Cases

- First station in section: No "Previous Shot" link shown
- Last station in section: No "Next Shot" link shown
- Section with single station (0 shots): Show "Only Station: X:Y" in Endpoints
- Unnamed section: Display as "section_id: Unnamed"
- Merged stations: Use primary section_id; other sections accessible via merged station links
- Missing link target: Show link with warning indicator (data inconsistency)
- Focus management: Standard tabbing, no special handling

## Open Questions

- None - all requirements clarified during interview

## Acceptance

### Hyperlinks
- [ ] Shot detail shows Start Station and End Station links in new "Connected" section
- [ ] Shot detail Section link uses "id: name" or "id: Unnamed" format
- [ ] Station detail shows Previous Shot and Next Shot links (hidden when N/A)
- [ ] Station detail Section link uses "id: name" format
- [ ] Station detail merged station references are clickable hyperlinks
- [ ] Section detail shows first/last station in new "Endpoints" section
- [ ] Section with 1 station shows "Only Station" instead of first/last
- [ ] All IDs use 1-indexed position format matching fn-20-mwj
- [ ] Clicking link changes selection and updates Detail Panel
- [ ] Clicking section link highlights section in Sections Panel
- [ ] Links use accent color + underline style
- [ ] All links have proper aria-labels
- [ ] ARIA live region announces selection changes
- [ ] All links keyboard accessible (Tab + Enter)
- [ ] Missing link targets show warning indicator
- [ ] DetailLink component is reusable across all detail types
- [ ] Appropriate data-testid on all links

### Center Button
- [ ] Panel component extended with rightAction prop
- [ ] Crosshairs button appears in Shot, Station, Section detail headers
- [ ] Button not visible in Project Stats view
- [ ] Button positioned far right of title row
- [ ] Small/subtle size with solid background
- [ ] Click pans and zooms map to fit element
- [ ] Tooltip shows "Center map on [type] X:Y"
- [ ] Button fully keyboard accessible
- [ ] Dynamic aria-label per element type
- [ ] Appropriate data-testid per element type

### Testing
- [ ] Unit tests for DetailLink component (TypeScript)
- [ ] Unit tests for ID formatting utilities (TypeScript + Rust if applicable)
- [ ] Playwright E2E tests for all link types and click behaviors
- [ ] Playwright E2E tests for center button functionality
- [ ] WebdriverIO tests for critical paths
- [ ] Screen reader testing for accessibility
