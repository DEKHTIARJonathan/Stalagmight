# fn-21-q0u.7 Playwright E2E tests for hyperlinks and center button

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
   - Merged station links clickable

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
   - Live region announces selection changes

### Mock Updates
Update `tauri-ipc.ts` to return test data with multiple sections, shots, and stations for testing navigation scenarios.

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
- [ ] Tests verify ARIA live announcements
- [ ] Tests verify edge cases (first/last station, single-station section)
- [ ] Mock data updated with multi-section test project
- [ ] All tests pass: `pnpm test:ui --grep "detail-panel-links"`
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
