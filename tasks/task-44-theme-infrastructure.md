# Task 44: Theme Infrastructure

## Overview
Set up CSS variable system with --cc- prefix for future theme support. Detect system high-contrast preference. Full high-contrast theme implementation deferred to v2.

## Priority
Medium - Phase D (Accessibility)

## Risk Level
Medium

## Dependencies
- None

## Files to Modify
- `src/styles/themes.css` - New file with CSS variables
- `src/styles/index.css` - Import themes
- `tailwind.config.js` - Reference CSS variables
- `src/hooks/useTheme.ts` - New hook for theme detection

## Specifications

### CSS Variable Naming
All theme variables use `--cc-` prefix (CaveChef):
```css
:root {
  /* Colors */
  --cc-bg-primary: #1a1a1a;
  --cc-bg-secondary: #2a2a2a;
  --cc-text-primary: #ffffff;
  --cc-text-secondary: #a0a0a0;
  --cc-accent: #3b82f6;
  --cc-error: #ef4444;
  --cc-warning: #f59e0b;
  --cc-success: #22c55e;

  /* Sizes */
  --cc-border-radius: 4px;
  --cc-focus-ring: 2px solid var(--cc-accent);

  /* Station/Line (from settings) */
  --cc-station-size: 6px;
  --cc-line-thickness: 2px;
}
```

### System Preference Detection
```typescript
const useTheme = () => {
  const prefersHighContrast = useMediaQuery(
    '(prefers-contrast: more)'
  );
  const prefersDark = useMediaQuery(
    '(prefers-color-scheme: dark)'
  );
  // ...
};
```

### High Contrast Mode (v1 Scope)
- Detect system preference
- Add `data-high-contrast` attribute to root
- Apply basic high-contrast overrides:
  - Increased border widths
  - Higher contrast ratios
  - Simplified gradients
- Full theme deferred to v2

### Tailwind Integration
```javascript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        'cc-bg-primary': 'var(--cc-bg-primary)',
        'cc-text-primary': 'var(--cc-text-primary)',
        // ...
      }
    }
  }
}
```

### Minimum Contrast Ratios
- Normal text: 4.5:1 (WCAG AA)
- Large text: 3:1
- UI components: 3:1
- Focus indicators: 3:1

## Acceptance Criteria
- [ ] CSS variables defined with --cc- prefix
- [ ] Tailwind references CSS variables
- [ ] System high-contrast detected
- [ ] Basic high-contrast overrides apply
- [ ] All contrast ratios meet WCAG AA
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Playwright Tests (Mocked IPC)
1. Test CSS variables defined with --cc- prefix
2. Test --cc-bg-primary applied to body
3. Test --cc-text-primary applied to text
4. Test --cc-accent applied to interactive elements
5. Test high-contrast detected via prefers-contrast
6. Test data-high-contrast attribute added when detected
7. Test contrast ratios meet WCAG AA (4.5:1 for text)
8. Test focus ring uses --cc-focus-ring variable

### WebdriverIO Tests (Full App)
1. Test theme variables work with real components
2. Test high-contrast mode with system preference
3. Test theme toggle persists (if implemented)
4. Test all UI elements respect theme variables
5. Test theme doesn't break on window resize

## Edge Cases
- Browser doesn't support prefers-contrast
- User toggles system preference while app open
- Theme variables missing (fallbacks)
