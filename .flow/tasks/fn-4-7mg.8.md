# fn-4-7mg.8 Add Playwright E2E tests for hit detection

## Description
Add Playwright E2E tests that verify hit detection at exact pixel distances.

## Test Strategy

### Setup

1. Create a test project with known station/shot positions
2. Set specific hitArea values in config (e.g., station.hitArea = 10, shot.hitArea = 8)
3. Calculate exact screen coordinates for test clicks

### Test Cases

#### Station Hit Detection

```typescript
test('station click detection at exact hitArea boundary', async ({ page }) => {
  // Station at known position
  const stationCenter = await getStationScreenCoords(page, 'section1', 0);

  // Click at hitArea - 1 (should hit)
  await page.mouse.click(stationCenter.x + 9, stationCenter.y);
  await expect(page.locator('[data-testid="selected-station"]')).toBeVisible();

  // Clear selection
  await page.keyboard.press('Escape');

  // Click at hitArea + 1 (should miss)
  await page.mouse.click(stationCenter.x + 11, stationCenter.y);
  await expect(page.locator('[data-testid="selected-station"]')).not.toBeVisible();
});
```

#### Shot Hit Detection

Similar tests for shots:
- Click at shotWidth/2 - 1 from line center (should hit)
- Click at shotWidth/2 + 1 from line center (should miss)

#### Hover Detection

Test that hover state triggers at correct distances.

#### Config Changes

Test that changing hitArea in config affects detection:
1. Set hitArea to 5
2. Click at 6px distance (miss)
3. Reload config with hitArea = 10
4. Click at 6px distance (hit)

### Helper Functions

```typescript
async function getStationScreenCoords(page, sectionId, stationIndex) {
  // Use evaluate to get station's screen position
}

async function getShotScreenCoords(page, sectionId, shotId) {
  // Get midpoint of shot line
}
```
## Acceptance
- [ ] Test: station click at hitArea-1 hits
- [ ] Test: station click at hitArea+1 misses
- [ ] Test: shot click at hitArea/2-1 hits
- [ ] Test: shot click at hitArea/2+1 misses
- [ ] Test: station hover at hitArea-1 triggers hover state
- [ ] Test: config reload changes hit detection boundaries
- [ ] Helper functions for getting screen coordinates
- [ ] Tests use known station/shot positions
- [ ] `pnpm test:ui` passes with new tests
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
