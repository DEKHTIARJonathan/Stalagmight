# fn-51-ctu.12 Implement Section Creation Logic

## Description
Implement backend calls that create sections when placed. Each placement type has specific logic.

## Files to Modify
- `src/components/Dialogs/DmpSectionConfigDialog.tsx`
- `src/store/projectStore.ts`

## Placement Implementations
1. **Place at 0,0**: `createSection(sectionData)` - station 0 at origin
2. **Zero Datum**: `createSection` then `setZeroDatum(sectionId, coordinates, stationIndex)`
3. **From Existing**: `createSection` then `mergeStations(importRef, targetRef, 'KeepRaw')`
4. **Manual**: `createSection` then `setSectionOffset(sectionId, offset)`

## Error Handling
- Show error toast on failure, stay in dialog
- Partial failure: section created but subsequent operation failed - mark as placed, show warning
- Subsequent edits call update/create/delete commands immediately

## References
- `tasks/urgent/task-12-section-creation-logic.md`
## Acceptance
- [ ] Place at 0,0 creates section at origin
- [ ] Zero Datum creates section and sets coordinates
- [ ] From Existing creates section and merges stations
- [ ] Manual placement creates section with offset
- [ ] Error toast shown on failure
- [ ] Partial failures handled gracefully
- [ ] Subsequent edits persist immediately
- [ ] TypeScript compiles without errors
## Done summary
Implemented section creation logic in App.tsx with support for all four placement types:

1. **Origin (0,0)**: Creates section at origin, no additional operations needed
2. **Zero Datum (GPS)**: Creates section, then calls setZeroDatum with coordinates
3. **From Existing**: Creates section, then calls mergeStations to connect to existing station
4. **Manual**: Creates section, then calls moveSection with calculated offset

Added helper functions:
- `editableShotToShotData`: Converts EditableShot to ShotData for backend
- `calculateStationPositions`: Calculates local station positions for offset calculation
- `handleImportSections`: Main callback that processes each section based on placement type

Error handling:
- Full failures show error dialog and continue to next section
- Partial failures (section created but subsequent operation failed) show warning
## Evidence
- Commits:
- Tests: typescript, playwright, rust
- PRs: