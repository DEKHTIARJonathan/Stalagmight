# fn-21-q0u.4 Add hyperlinks and center button to StationDetail

## Description
Add hyperlinks and center button to the StationDetail component.

**Size:** M
**Files:** `src/components/SingleSystemView/DetailPanel.tsx` (StationDetail function at L255-319)

## Approach

### New "Connected" section
Add bordered section before Edit button (before L312) with:
- **Previous Shot**: Link to shot at position = station_index (hidden if station_index = 0)
- **Next Shot**: Link to shot at position = station_index + 1 (hidden if last station)
- **Section**: Link to section using format `sectionId: sectionName`

### Station Previous/Next Shot Mapping (CRITICAL - verify with examples)
Station at `station_index` has:
- Previous shot: `section.shots[station_index - 1]` (display position = station_index)
- Next shot: `section.shots[station_index]` (display position = station_index + 1)

**Concrete examples to verify implementation:**
- Station index 0 (display "1"): No previous shot (hidden), Next shot = shots[0] (display "1")
- Station index 1 (display "2"): Previous shot = shots[0] (display "1"), Next shot = shots[1] (display "2")
- Station index 5 (display "6"): Previous shot = shots[4] (display "5"), Next shot = shots[5] (display "6") - if exists
- Last station (index = shots.length): Previous shot = shots[shots.length-1], No next shot (hidden)

### Target Validation
Before rendering each link, validate the target exists:
- **Shot links**: Check if shot exists at the computed index in section.shots array
- **Merged station links**: Check if each merged station exists in `stations` array

Pass `isMissing={!exists}` to DetailLink for missing targets.

### Merged Stations
Update existing "Merged with" list (L297-308) to use DetailLink for each merged station reference.

### ID Format
- Shot display: `sectionId:shotPosition` where shotPosition = shot array index + 1
- Station display for merged: `sectionId:stationPosition`

### data-testid Format
- Shot links: `shot-{sectionId}-{position}-link`
- Section link: `section-{sectionId}-link`
- Merged station links: `station-{sectionId}-{position}-link`

### Center Button
Add inline SVG crosshairs button to Panel header using `headerActions` prop:
- Icon: Inline SVG crosshairs (follow pattern at ShortcutRecorder.tsx:309-320)
- onClick: Call `triggerCenterOnStation(station.station_ref)`
- aria-label: `Center map on station {sectionId}:{stationPosition}`
- data-testid: `center-station-button`

### Edge cases
- First station (station_index = 0): Hide "Previous Shot" row entirely
- Last station: Hide "Next Shot" row entirely (station_index >= section.shots.length)

## Acceptance
- [ ] "Connected" bordered section appears before Edit button
- [ ] Previous Shot link hidden for first station, visible otherwise
- [ ] Next Shot link hidden for last station, visible otherwise
- [ ] Shot link targets validated - `isMissing` passed to DetailLink when not found
- [ ] Section link shows `sectionId: name` format with `data-testid="section-{sectionId}-link"`
- [ ] Merged station references are clickable DetailLink components
- [ ] Merged station links validated - `isMissing` passed when not found
- [ ] Inline SVG crosshairs button in header calls `triggerCenterOnStation`
- [ ] All links use DetailLink component with appropriate data-testid
- [ ] All links have proper aria-labels
- [ ] Clicking links updates selection correctly

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
