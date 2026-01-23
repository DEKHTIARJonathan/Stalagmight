# fn-21-q0u.7 Playwright E2E tests for hyperlinks and center button

<!-- Updated by plan-sync: fn-21-q0u.4 - ARIA live region selector is #selection-announcer in App.tsx -->

## Description
Create comprehensive Playwright E2E tests for hyperlinks and center button functionality.

**Size:** M
**Files:** `e2e-playwright/detail-panel-links.spec.ts` (new), `e2e-playwright/mocks/tauri-ipc.ts` (update)

## Approach

### Test Scenarios
1. **Shot Detail Links**
   - Click Start Station link → selection changes to station
   - Click End Station link → selection changes to station
   - Click Section link → selection changes to section, highlights in Sections Panel

2. **Station Detail Links**
   - Click Previous Shot link → selection changes to shot
   - Click Next Shot link → selection changes to shot
   - First station: Previous Shot not visible
   - Last station: Next Shot not visible
   - Merged station links clickable (requires mock with merged stations)

3. **Section Detail Links**
   - Click First Station link → selection changes
   - Click Last Station link → selection changes
   - Single-station section shows "Only Station"

4. **Center Buttons**
   - Click center button → verify map state request triggered
   - Button has correct aria-label
   - Button keyboard accessible (Tab + Enter)

5. **Keyboard Navigation**
   - Tab through links in detail panel
   - Enter activates focused link
   - Focus ring visible

6. **Accessibility**
   - All links have aria-labels
   - Live region announces selection changes (target: `#selection-announcer` in App.tsx)

### Mock Updates - MUST include merged stations
Update `tauri-ipc.ts` to return test data with:
- Multiple sections
- Multiple shots per section
- Multiple stations per section
- **At least one station with `merged_with` array** containing valid station refs to other sections

Example mock structure for merged station:
```typescript
{
  station_ref: { section_id: 1, station_index: 3 },
  merged_with: [
    { section_id: 2, station_index: 0 }  // References station in section 2
  ]
}
```

## Key context
- Follow existing test patterns in `e2e-playwright/`
- Use `setupMockedPage()` and `createProject()` helpers
- Use `data-testid` selectors for reliability

## Acceptance
- [ ] New test file `e2e-playwright/detail-panel-links.spec.ts` created
- [ ] Tests for all Shot Detail link types (start station, end station, section)
- [ ] Tests for all Station Detail link types (prev/next shot, section, merged)
- [ ] Tests for Section Detail endpoint links
- [ ] Tests for center button click behavior
- [ ] Tests for keyboard navigation (Tab + Enter)
- [ ] Tests verify ARIA live announcements (check `#selection-announcer` text content)
- [ ] Tests verify edge cases (first/last station, single-station section)
- [ ] Mock data includes station with `merged_with` references
- [ ] All tests pass: `pnpm test:ui --grep "detail-panel-links"`

## Done summary
Created comprehensive Playwright E2E test suite for detail panel hyperlinks and center buttons covering Shot, Station, and Section detail views with 24 tests for link navigation, keyboard accessibility, ARIA live announcements, and edge cases including merged stations.
## Evidence
- Commits: d7bb18b2f11a2430d92b88837675ee42ed561aee
- Tests: pnpm test:ui --grep detail-panel-links (24 passed)
- PRs: