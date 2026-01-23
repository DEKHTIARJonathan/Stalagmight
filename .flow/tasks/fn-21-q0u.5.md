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
- [x] "Endpoints" bordered section appears after Depth Range
- [x] First Station link shows 1-indexed position and navigates to station
- [x] Last Station link shows 1-indexed position and navigates to station
- [x] Station link targets validated - `isMissing` passed to DetailLink when not found
- [x] Single-station sections show "Only Station" instead of First/Last
- [x] Inline SVG crosshairs button in header calls `triggerZoomToSection`
- [x] All links use DetailLink component with `data-testid="station-{sectionId}-{position}-link"`
- [x] All links have proper aria-labels
- [x] Clicking links updates selection correctly

## Done summary
Added Endpoints section to SectionDetail showing First/Last station links (or "Only Station" for single-station sections) with validated targets and isMissing indicators, plus inline SVG crosshairs center button using headerActions prop that triggers triggerZoomToSection.

## Evidence
- Commits: 20fc49e6a5846e52d52af99ca5e979bd3bd63537
- Tests: pnpm tsc --noEmit, pnpm test:ui
- PRs:
