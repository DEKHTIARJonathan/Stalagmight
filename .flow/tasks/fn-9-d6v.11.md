# fn-9-d6v.11 WebdriverIO accessibility and visual tests

## Description
WebdriverIO accessibility and visual tests for section highlighting.

## Test File: `tests/wdio/section-highlighting.test.ts`

### Accessibility Tests (per interview: "Both a11y + visual")

**1. ARIA structure:**
```typescript
describe('Section panel accessibility', () => {
  it('panel has correct listbox role', async () => {
    // Verify role="listbox" on container
    // Verify aria-label is present
  });

  it('section rows have option role and aria-selected', async () => {
    // Verify role="option" on each row
    // Verify aria-selected matches selection state
  });
});
```

**2. Keyboard navigation accessibility:**
```typescript
describe('Keyboard navigation', () => {
  it('Tab moves focus into section panel', async () => {
    // Tab from elsewhere
    // Verify focus moves to panel
  });

  it('Arrow keys move focus between options', async () => {
    // Navigate with arrows
    // Verify focus indicator visible on each row
  });

  it('focus visible on keyboard navigation', async () => {
    // Verify focus ring/outline visible when using keyboard
    // Should match system focus styles
  });
});
```

**3. Screen reader announcements:**
```typescript
describe('Screen reader support', () => {
  it('section row announces selection state', async () => {
    // Verify aria-selected updates
    // Check that screen reader would announce "selected" state
  });

  it('panel announces as navigation landmark', async () => {
    // Verify aria-label provides context
  });
});
```

### Visual Behavior Tests

**4. Highlight appearance consistency:**
```typescript
describe('Visual highlight states', () => {
  it('hover state appears on mouse enter', async () => {
    // Move mouse to section row
    // Verify background color changes
  });

  it('selection state appears on click', async () => {
    // Click section row
    // Verify selection styling applied
  });

  it('map hover triggers panel highlight', async () => {
    // Hover map feature
    // Verify panel row shows highlight
  });
});
```

**5. Cross-browser consistency:**
```typescript
describe('Cross-browser visual consistency', () => {
  // Test on Chrome, Firefox, Safari (if configured)
  // Verify highlight colors and transitions work across browsers
});
```

## WebdriverIO Configuration
Use existing wdio config. Tests focus on:
- Real browser accessibility testing
- Keyboard interaction verification
- Visual state verification via computed styles
## Acceptance
- [ ] Test file created at appropriate WebdriverIO location
- [ ] Test: Panel has role="listbox" and aria-label
- [ ] Test: Section rows have role="option" and aria-selected
- [ ] Test: Tab moves focus into panel
- [ ] Test: Arrow keys move focus between options
- [ ] Test: Focus visible indicator on keyboard navigation
- [ ] Test: aria-selected updates on selection change
- [ ] Test: Mouse hover triggers visual highlight
- [ ] Test: Click triggers selection visual state
- [ ] Test: Map hover triggers panel row highlight
- [ ] Tests verify computed styles for highlight states
- [ ] All tests pass with WebdriverIO test runner
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
