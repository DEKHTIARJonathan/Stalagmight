# fn-9-d6v.10 Playwright E2E tests for section highlighting

## Description
Comprehensive Playwright E2E tests for section hover/selection highlighting.

## Test File: `e2e-playwright/section-highlighting.spec.ts`

### Test Scenarios (per interview: "All scenarios")

**1. Panel hover → map highlight:**
```typescript
test('hovering section row highlights all shots/stations on map', async ({ page }) => {
  // Load project with multiple sections
  // Hover section row in panel using data-testid="section-row-{id}"
  // Verify features with that sectionId have hover styling
});
```

**2. Panel click → map selection:**
```typescript
test('clicking section row selects and highlights section on map', async ({ page }) => {
  // Click section row
  // Verify row shows selected state (bg-accent/20)
  // Verify map features show selected styling
  // Verify selection persists
});
```

**3. Map hover → panel highlight (bidirectional):**
```typescript
test('hovering station on map highlights parent section in panel', async ({ page }) => {
  // Hover station feature on map
  // Verify corresponding section row in panel shows highlight
});

test('hovering shot on map highlights parent section in panel', async ({ page }) => {
  // Hover shot line on map
  // Verify corresponding section row in panel shows highlight
});
```

**4. Priority conflicts:**
```typescript
test('individual hover takes priority over section selection', async ({ page }) => {
  // Select a section
  // Hover individual station within same section
  // Verify individual hover styling overrides section styling
});

test('hover overrides selection when different sections', async ({ page }) => {
  // Select section A
  // Hover section B row in panel
  // Verify section B has hover styling, section A has selection styling
});
```

**5. Unhover behavior:**
```typescript
test('map highlight clears when mouse leaves section row', async ({ page }) => {
  // Hover section row
  // Move mouse away from row
  // Verify map features return to normal styling
});

test('panel highlight clears when mouse leaves map features', async ({ page }) => {
  // Hover map features
  // Move mouse to empty map area
  // Verify panel row loses highlight
});
```

**6. Keyboard navigation:**
```typescript
test('arrow keys navigate between section rows', async ({ page }) => {
  // Tab to sections panel
  // Press ArrowDown
  // Verify next row is focused and section highlighted on map
});

test('Enter selects focused section', async ({ page }) => {
  // Navigate to section with arrows
  // Press Enter
  // Verify section is selected
});

test('Escape clears selection', async ({ page }) => {
  // Select a section
  // Press Escape
  // Verify selection cleared
});
```

**7. Edge cases:**
```typescript
test('empty section is interactive but shows no map highlight', async ({ page }) => {
  // Test with section that has no shots
  // Hover/click should work but no features to highlight
});

test('virtual shots highlight with section', async ({ page }) => {
  // Test section with virtual shots
  // Verify virtual shots also get highlight styling
});
```

## Test Utilities
Use existing test helpers from `e2e-playwright/fixtures/` and `e2e-playwright/mocks/` for:
- Loading test projects
- Map interaction helpers (wait for `__cavechef_map__`)
- MapLibre canvas interactions
## Test File: `tests/e2e/section-highlighting.spec.ts`

### Test Scenarios (per interview: "All scenarios")

**1. Panel hover → map highlight:**
```typescript
test('hovering section row highlights all shots/stations on map', async ({ page }) => {
  // Load project with multiple sections
  // Hover section row in panel
  // Verify all features with that sectionId have hover styling
  // Use visual inspection or query map layer paint properties
});
```

**2. Panel click → map selection:**
```typescript
test('clicking section row selects and highlights section on map', async ({ page }) => {
  // Click section row
  // Verify row shows selected state
  // Verify map features show selected styling
  // Verify selection persists until another click
});
```

**3. Map hover → panel highlight (bidirectional):**
```typescript
test('hovering station on map highlights parent section in panel', async ({ page }) => {
  // Hover station feature on map
  // Verify corresponding section row in panel shows highlight
});

test('hovering shot on map highlights parent section in panel', async ({ page }) => {
  // Hover shot line on map
  // Verify corresponding section row in panel shows highlight
});
```

**4. Priority conflicts:**
```typescript
test('individual hover takes priority over section selection', async ({ page }) => {
  // Select a section
  // Hover individual station within same section
  // Verify individual hover styling overrides section styling
});

test('hover overrides selection when different sections', async ({ page }) => {
  // Select section A
  // Hover section B row in panel
  // Verify section B has hover styling, section A has selection styling
});
```

**5. Unhover behavior:**
```typescript
test('map highlight clears when mouse leaves section row', async ({ page }) => {
  // Hover section row
  // Move mouse away from row
  // Verify map features return to normal styling
});

test('panel highlight clears when mouse leaves map features', async ({ page }) => {
  // Hover map features
  // Move mouse to empty map area
  // Verify panel row loses highlight
});
```

**6. Keyboard navigation:**
```typescript
test('arrow keys navigate between section rows', async ({ page }) => {
  // Tab to sections panel
  // Press ArrowDown
  // Verify next row is focused and section highlighted on map
});

test('Enter selects focused section', async ({ page }) => {
  // Navigate to section with arrows
  // Press Enter
  // Verify section is selected
});

test('Escape clears selection', async ({ page }) => {
  // Select a section
  // Press Escape
  // Verify selection cleared
});
```

**7. Edge cases:**
```typescript
test('empty section is interactive but shows no map highlight', async ({ page }) => {
  // Test with section that has no shots
  // Hover/click should work but no features to highlight
});

test('virtual shots highlight with section', async ({ page }) => {
  // Test section with virtual shots
  // Verify virtual shots also get highlight styling
});
```

## Test Utilities
Use existing test helpers from `tests/e2e/utils/` for:
- Loading test projects
- Map interaction helpers
- Waiting for map to render
## Acceptance
- [ ] Test file created at `e2e-playwright/section-highlighting.spec.ts`
- [ ] Test: Panel hover highlights map (uses data-testid="section-row-{id}")
- [ ] Test: Panel click selects and highlights map
- [ ] Test: Station hover on map highlights panel row
- [ ] Test: Shot hover on map highlights panel row
- [ ] Test: Individual hover priority over section selection
- [ ] Test: Hover overrides selection (different sections)
- [ ] Test: Highlight clears on mouse leave (panel → map)
- [ ] Test: Highlight clears on mouse leave (map → panel)
- [ ] Test: Arrow key navigation between rows
- [ ] Test: Enter selects focused section
- [ ] Test: Escape clears selection
- [ ] Test: Empty section edge case
- [ ] Test: Virtual shots included in highlight
- [ ] All tests pass with `pnpm test:ui`
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
