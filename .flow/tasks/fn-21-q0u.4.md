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
Add crosshairs button to Panel header using `headerActions` prop:
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
- [ ] Crosshairs button in header calls `triggerCenterOnStation`
- [ ] All links use DetailLink component with appropriate data-testid
- [ ] All links have proper aria-labels
- [ ] Clicking links updates selection correctly

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
