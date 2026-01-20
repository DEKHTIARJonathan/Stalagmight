# fn-3-e6v.9 Add E2E tests for visibility toggle behavior

## Description
Add E2E tests for visibility toggle behavior.

## Files to Create

### `tests/display-toggles.spec.ts`

Follow patterns from existing Playwright tests in `tests/` directory.

## Test Scenarios

### Visibility Tests
```typescript
test('toggle stations hides station markers', async ({ page }) => {
  // Load project with stations
  // Open Display menu
  // Uncheck "Stations"
  // Verify station markers not visible on canvas
  // Re-check "Stations"
  // Verify station markers reappear
});

test('toggle shots hides shot lines', async ({ page }) => {
  // Similar for shots
});
```

### Selection Blocking Tests
```typescript
test('cannot select hidden stations', async ({ page }) => {
  // Hide stations
  // Click on known station location
  // Verify no selection occurred
});

test('no hover effect on hidden stations', async ({ page }) => {
  // Hide stations
  // Move mouse to station location
  // Verify no hover styling
});
```

### Selection Clearing Tests
```typescript
test('selection cleared when stations hidden', async ({ page }) => {
  // Select a station
  // Verify selection indicator
  // Hide stations
  // Verify selection cleared
});

test('mixed selection only clears hidden type', async ({ page }) => {
  // Select both station and shot
  // Hide stations only
  // Verify station deselected, shot still selected
});
```

### Toast Tests
```typescript
test('toast appears when clicking hidden station area', async ({ page }) => {
  // Hide stations
  // Click station area
  // Verify toast with correct message appears
});

test('toast is throttled', async ({ page }) => {
  // Hide stations
  // Click rapidly multiple times
  // Verify only one toast shown
  // Wait 5 seconds
  // Click again
  // Verify new toast appears
});
```

### Toggle Relationship Tests
```typescript
test('Virtual Shots disabled when Shots hidden', async ({ page }) => {
  // Open Display menu
  // Uncheck "Shots"
  // Verify "Virtual Shots" toggle is disabled
  // Verify "Shot Data" toggle is disabled
});

test('dependent toggles re-enable when Shots shown', async ({ page }) => {
  // Set Virtual Shots to unchecked
  // Hide then show Shots
  // Verify Virtual Shots re-enabled but still unchecked
});
```

### Tool Operation Tests
```typescript
test('draw operation canceled when stations hidden mid-draw', async ({ page }) => {
  // Start draw from station
  // Hide stations
  // Verify draw canceled
  // Verify toast shown
});

test('snap indicator shows station during draw with hidden stations', async ({ page }) => {
  // Hide stations
  // Start draw tool
  // Move cursor near station
  // Verify station becomes visible (snap indicator)
});
```

## Test Data

Use test fixtures from `tests/fixtures/` or create minimal survey data for these tests.
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
- [ ] Test file exists at `tests/display-toggles.spec.ts`
- [ ] E2E test: station visibility toggle works
- [ ] E2E test: shot visibility toggle works
- [ ] E2E test: selection blocked when elements hidden
- [ ] E2E test: hover effect blocked when elements hidden
- [ ] E2E test: selection cleared on toggle
- [ ] E2E test: mixed selection preserves non-hidden type
- [ ] E2E test: toast notification on hidden element interaction
- [ ] E2E test: toast throttling (5 second cooldown)
- [ ] E2E test: Virtual Shots toggle disabled when Shots hidden
- [ ] E2E test: Shot Data toggle disabled when Shots hidden
- [ ] E2E test: operation canceled on visibility change
- [ ] E2E test: snap indicator shows station during Draw
- [ ] All E2E tests pass: `pnpm test:ui`
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
