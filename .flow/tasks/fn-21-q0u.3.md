# fn-21-q0u.3 Add hyperlinks and center button to ShotDetail

## Description
Add hyperlinks and center button to the ShotDetail component.

**Size:** M
**Files:** `src/components/SingleSystemView/DetailPanel.tsx` (ShotDetail function at L321-385)

## Approach

### New "Connected" section
Add bordered section after LRUD section (after L360) with:
- **Start Station**: Link to station at index = shot array index (1-indexed display)
- **End Station**: Link to station at index = shot array index + 1 (1-indexed display)
- **Section**: Link to section using format `sectionId: sectionName` or `sectionId: Unnamed`

### Target Validation
Before rendering each link, validate the target exists:
- **Station links**: Check if station exists in `stations` array matching `section_id` and `station_index`
- **Section link**: Always exists (we have the section object)

Pass `isMissing={!exists}` to DetailLink for missing station targets.

### ID Format (from fn-20-mwj)
- Station display: `sectionId:stationPosition` where stationPosition = station_index + 1
- Section display: `sectionId: sectionName`

### data-testid Format
- Station links: `station-{sectionId}-{position}-link`
- Section link: `section-{sectionId}-link`

### Center Button
Add crosshairs button to Panel header using `headerActions` prop:
- Icon: Crosshairs from lucide-react
- onClick: Call `triggerCenterOnShot(section.id, shot.id)`
- aria-label: `Center map on shot {sectionId}:{shotPosition}`
- data-testid: `center-shot-button`

### Selection handlers
- Station link: `setSelection({ type: 'station', stationRef: { section_id, station_index } })`
- Section link: `setSelection({ type: 'section', sectionId })`

## Acceptance
- [ ] "Connected" bordered section appears after LRUD section
- [ ] Start Station link shows 1-indexed position and navigates to station
- [ ] End Station link shows 1-indexed position and navigates to station
- [ ] Station link targets validated - `isMissing` passed to DetailLink when not found
- [ ] Section link shows `sectionId: name` format and navigates to section
- [ ] Section link uses `data-testid="section-{sectionId}-link"`
- [ ] Crosshairs button in header calls `triggerCenterOnShot`
- [ ] All links use DetailLink component with appropriate data-testid
- [ ] All links have proper aria-labels
- [ ] Clicking links updates selection correctly

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
