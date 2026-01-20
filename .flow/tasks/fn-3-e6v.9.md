# fn-3-e6v.9 Add E2E tests for visibility toggle behavior

## Description
Add E2E tests for visibility toggle behavior.

## Files to Create/Modify
- Create E2E test file (e.g., `tests/display-toggles.spec.ts`)
- Follow patterns in existing Playwright tests

## Test Scenarios

### Visibility Tests
1. Toggle Stations off: verify station markers are not visible on canvas
2. Toggle Stations on: verify station markers reappear
3. Toggle Shots off: verify shot lines are not visible
4. Toggle Shots on: verify shot lines reappear

### Selection Blocking Tests
1. With Stations hidden: click on station location, verify no selection
2. With Stations hidden: verify hover effect does not appear
3. With Shots hidden: click on shot line area, verify no selection

### Selection Clearing Tests
1. Select a station, toggle Stations off, verify selection cleared
2. Select a shot, toggle Shots off, verify selection cleared
3. Select both station and shot, toggle Stations off, verify only station deselected

### Toast Notification Tests
1. With Stations hidden: click station area, verify toast appears
2. Click rapidly, verify toast is throttled (only shows once per 5 seconds)

### Toggle Relationship Tests
1. Toggle Shots off: verify Virtual Shots toggle is disabled
2. Toggle Shots off: verify Shot Data toggle is disabled
3. Toggle Shots back on: verify toggles re-enable

### Tool Operation Tests
1. Start Draw, toggle Stations off, verify operation canceled
2. During Draw with hidden stations, verify snap indicator still shows station

## Depends On
- Tasks 5, 6, 7: All behavior must be implemented
## Acceptance
- [ ] E2E test for station visibility toggle
- [ ] E2E test for shot visibility toggle
- [ ] E2E test for selection blocking when elements hidden
- [ ] E2E test for hover effect blocking when elements hidden
- [ ] E2E test for selection clearing on toggle
- [ ] E2E test for toast notification on hidden element interaction
- [ ] E2E test for toast throttling
- [ ] E2E test for Virtual Shots toggle disabled when Shots hidden
- [ ] E2E test for Shot Data toggle disabled when Shots hidden
- [ ] E2E test for operation cancellation on visibility change
- [ ] E2E test for snap indicator exception during Draw
- [ ] All E2E tests pass
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
