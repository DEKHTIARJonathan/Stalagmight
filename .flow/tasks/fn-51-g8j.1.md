# fn-51-g8j.1 Define CSS variable tokens and theme definitions in index.css

## Description

Add a complete set of `--cc-*` CSS custom properties to `src/index.css` with two theme blocks: dark (default, matching existing palette) and light (derived from brand_tokens.css).

## Files to modify

- `src/index.css` — Add `:root, [data-theme="dark"]` and `[data-theme="light"]` blocks at the top (after @tailwind directives, before other styles)

## Implementation

Add the following CSS variable blocks after the `@tailwind utilities;` line and before the `/* Base styles */` comment:

### Dark theme (default — matches current hardcoded values exactly)
```css
:root, [data-theme="dark"] {
  /* Surface colors */
  --cc-background: #1a1a2e;
  --cc-panel: #16213e;
  --cc-border: #0f3460;
  
  /* Text colors */
  --cc-text-primary: #f5f5f5;
  --cc-text-secondary: #a0a0a0;
  
  /* Semantic colors */
  --cc-accent: #4ecdc4;
  --cc-accent-on: #1a1a2e;
  --cc-warning: #ffcb77;
  --cc-error: #ff6b6b;
  --cc-success: #95e1d3;
  
  /* Interactive states */
  --cc-hover: rgba(78, 205, 196, 0.1);
  --cc-focus-ring: #4ecdc4;
  --cc-focus-glow: rgba(78, 205, 196, 0.5);
  
  /* Scrollbar */
  --cc-scrollbar-track: #16213e;
  --cc-scrollbar-thumb: #0f3460;
  --cc-scrollbar-hover: #4ecdc4;
  
  /* Form controls */
  --cc-input-bg: #16213e;
  --cc-input-border: #0f3460;
  
  /* DatePicker */
  --cc-outside-month: #666;
  
  /* MapLibre */
  --cc-map-ctrl-bg: #16213e;
  --cc-map-ctrl-border: #0f3460;
  --cc-map-ctrl-hover: #1a1a2e;
  --cc-map-ctrl-active: #0f3460;
  --cc-map-ctrl-icon-filter: brightness(0) invert(1);
  --cc-map-scale-bg: rgba(26, 26, 46, 0.85);
  --cc-map-scale-border: rgba(255, 255, 255, 0.7);
  --cc-map-scale-text: #ffffff;
  
  /* Selection indicator */
  --cc-selection-gradient: rgba(78, 205, 196, 0.3);
  
  color-scheme: dark;
}
```

### Light theme (derived from brand_tokens.css warm palette)
```css
[data-theme="light"] {
  /* Surface colors */
  --cc-background: #f5f0e8;
  --cc-panel: #ffffff;
  --cc-border: #d4c5a9;
  
  /* Text colors */
  --cc-text-primary: #1a120b;
  --cc-text-secondary: #6b5b4a;
  
  /* Semantic colors */
  --cc-accent: #3a8a82;
  --cc-accent-on: #ffffff;
  --cc-warning: #c4901a;
  --cc-error: #c44040;
  --cc-success: #2a7a6a;
  
  /* Interactive states */
  --cc-hover: rgba(58, 138, 130, 0.08);
  --cc-focus-ring: #3a8a82;
  --cc-focus-glow: rgba(58, 138, 130, 0.4);
  
  /* Scrollbar */
  --cc-scrollbar-track: #ebe4d8;
  --cc-scrollbar-thumb: #c1a07a;
  --cc-scrollbar-hover: #3a8a82;
  
  /* Form controls */
  --cc-input-bg: #ffffff;
  --cc-input-border: #d4c5a9;
  
  /* DatePicker */
  --cc-outside-month: #aaa;
  
  /* MapLibre */
  --cc-map-ctrl-bg: #ffffff;
  --cc-map-ctrl-border: #d4c5a9;
  --cc-map-ctrl-hover: #f5f0e8;
  --cc-map-ctrl-active: #ebe4d8;
  --cc-map-ctrl-icon-filter: none;
  --cc-map-scale-bg: rgba(255, 255, 255, 0.9);
  --cc-map-scale-border: rgba(0, 0, 0, 0.5);
  --cc-map-scale-text: #1a120b;
  
  /* Selection indicator */
  --cc-selection-gradient: rgba(58, 138, 130, 0.2);
  
  color-scheme: light;
}
```

## Acceptance

- [ ] `:root, [data-theme="dark"]` block defines all `--cc-*` variables matching current hardcoded hex values
- [ ] `[data-theme="light"]` block defines all same variables with light theme values
- [ ] Both blocks include `color-scheme` property
- [ ] Dark theme values match existing hardcoded values exactly (no visual change)
- [ ] Light theme values are readable and WCAG AA compliant (4.5:1 text contrast)
- [ ] Variables placed after @tailwind directives, before base styles
- [ ] No existing styles broken (this task only adds, doesn't replace yet)
