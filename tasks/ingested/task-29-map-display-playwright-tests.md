# Task 29: Add Playwright tests for map display features

## Overview
Add comprehensive Playwright E2E tests for the map display features from Phase 2 (Tasks 7-9) and Phase 6 (Tasks 23-24).

## Priority
High - Phase 7 (Testing & Quality)

## Risk Level
Low

## Dependencies
- Tasks 7-9, 23-24 implemented

## Files to Modify
- `e2e-playwright/map-display.spec.ts` - New test file

## Specifications

### Test Approach
- All testing methods: visual, interaction, state
- Visual regression where appropriate

### Test Scope
- Scale bar toggle (Task 7)
- Section name labels (Task 8)
- Station index labels (Task 9)
- Grid overlay (Task 23)
- Satellite imagery toggle (Task 24)

### Map Test Methods
- Visibility tests (elements shown/hidden)
- Toggle interaction tests
- State persistence tests
- Visual regression tests

### Test Structure
```typescript
test.describe('Map Display Features', () => {
  test.describe('Scale Bar', () => {
    test('shows scale bar when enabled', async ({ page }) => {});
    test('hides scale bar when disabled', async ({ page }) => {});
  });

  test.describe('Section Labels', () => {
    test('shows section names at first station', async ({ page }) => {});
    test('labels use section color', async ({ page }) => {});
  });

  test.describe('Grid Overlay', () => {
    test('shows grid when enabled', async ({ page }) => {});
    test('grid spacing can be changed', async ({ page }) => {});
  });

  // ... more test suites
});
```

## Acceptance Criteria
- [ ] Scale bar toggle tests pass
- [ ] Section label tests pass
- [ ] Station label tests pass
- [ ] Grid overlay tests pass
- [ ] Satellite toggle tests pass
- [ ] Visual tests included
- [ ] Toggle interactions verified
- [ ] Tests run in CI

## Test Requirements

### Specific Tests to Write

#### Scale Bar (Task 7)
- `test('scale bar visible when enabled')`
- `test('scale bar hidden when disabled')`
- `test('toggle changes visibility')`

#### Section Labels (Task 8)
- `test('section labels visible when enabled')`
- `test('labels at first station')`
- `test('labels match section color')`
- `test('labels hidden when disabled')`

#### Station Labels (Task 9)
- `test('station labels visible at high zoom')`
- `test('station labels hidden at low zoom')`
- `test('labels show correct indices')`

#### Grid (Task 23)
- `test('grid visible when enabled')`
- `test('grid hidden when disabled')`
- `test('grid spacing dropdown works')`

#### Satellite (Task 24)
- `test('satellite tiles when enabled')`
- `test('dark background when disabled')`
- `test('toggle switches instantly')`

## Edge Cases
- Toggle during pan/zoom
- Labels with very long names
- Grid at extreme zoom levels
- Satellite with no internet (mock offline)

## Implementation Notes
- May need to mock MapLibre for some tests
- Consider canvas/WebGL testing limitations
- Visual regression for styling verification
- Low risk: testing implemented features
