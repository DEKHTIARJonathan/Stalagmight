# fn-21-q0u.5 Add Endpoints section and center button to SectionDetail

## Description
Add Endpoints section and center button to the SectionDetail component.

**Size:** M
**Files:** `src/components/SingleSystemView/DetailPanel.tsx` (SectionDetail function at L393-492)

## Approach

### New "Endpoints" section
Add new bordered section (similar to existing "Survey Statistics" section) with:
- **First Station**: Link to station at index 0
- **Last Station**: Link to station at last index (section.shots.length)

### Target Validation
Before rendering each link, validate the target exists:
- **Station links**: Check if station exists in `stations` array filtered by section_id

Pass `isMissing={!exists}` to DetailLink for missing targets.

### Single Station Edge Case
If section has only 1 station (0 shots):
- Show single row: "Only Station: sectionId:1"

### ID Format
- Station display: `sectionId:stationPosition` where stationPosition = station_index + 1

### data-testid Format
- Station links: `station-{sectionId}-{position}-link`

### Center Button
Add inline SVG crosshairs button to Panel header using `headerActions` prop:
- Icon: Inline SVG crosshairs (follow pattern at ShortcutRecorder.tsx:309-320)
- onClick: Call `triggerZoomToSection(section.id)` (reuse existing)
- aria-label: `Center map on section {sectionId}: {sectionName}`
- data-testid: `center-section-button`

### Placement
Add "Endpoints" section after "Depth Range" section (around L463), before "Project Contribution" section.

## Acceptance
- [ ] "Endpoints" bordered section appears after Depth Range
- [ ] First Station link shows 1-indexed position and navigates to station
- [ ] Last Station link shows 1-indexed position and navigates to station
- [ ] Station link targets validated - `isMissing` passed to DetailLink when not found
- [ ] Single-station sections show "Only Station" instead of First/Last
- [ ] Inline SVG crosshairs button in header calls `triggerZoomToSection`
- [ ] All links use DetailLink component with `data-testid="station-{sectionId}-{position}-link"`
- [ ] All links have proper aria-labels
- [ ] Clicking links updates selection correctly

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
