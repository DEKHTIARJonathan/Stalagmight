# fn-51-g8j.1 Define CSS variable tokens and theme definitions in index.css

## Description

Add a comprehensive set of `--cc-*` CSS custom properties to `src/index.css` with two theme blocks: dark (default, matching existing palette) and light (derived from brand_tokens.css). Includes UI chrome tokens, map visualization tokens, canvas preview tokens, and opacity variant tokens.

## Files to modify

- `src/index.css` — Add `:root, [data-theme="dark"]` and `[data-theme="light"]` blocks at the top (after @tailwind directives, before other styles)

## Implementation

Add after `@tailwind utilities;` and before `/* Base styles */`:

### Dark theme (default)
```css
:root, [data-theme="dark"] {
  /* ── Surface colors ── */
  --cc-background: #1a1a2e;
  --cc-panel: #16213e;
  --cc-border: #0f3460;
  
  /* ── Text colors ── */
  --cc-text-primary: #f5f5f5;
  --cc-text-secondary: #a0a0a0;
  
  /* ── Semantic colors ── */
  --cc-accent: #4ecdc4;
  --cc-accent-on: #1a1a2e;
  --cc-warning: #ffcb77;
  --cc-error: #ff6b6b;
  --cc-success: #95e1d3;
  
  /* ── Interactive states ── */
  --cc-hover: rgba(78, 205, 196, 0.1);
  --cc-focus-ring: #4ecdc4;
  --cc-focus-glow: rgba(78, 205, 196, 0.5);
  
  /* ── Scrollbar ── */
  --cc-scrollbar-track: #16213e;
  --cc-scrollbar-thumb: #0f3460;
  --cc-scrollbar-hover: #4ecdc4;
  
  /* ── Form controls ── */
  --cc-input-bg: #16213e;
  --cc-input-border: #0f3460;
  
  /* ── DatePicker ── */
  --cc-outside-month: #666;
  
  /* ── Selection indicator ── */
  --cc-selection-gradient: rgba(78, 205, 196, 0.3);
  
  /* ── MapLibre controls ── */
  --cc-map-ctrl-bg: #16213e;
  --cc-map-ctrl-border: #0f3460;
  --cc-map-ctrl-hover: #1a1a2e;
  --cc-map-ctrl-active: #0f3460;
  --cc-map-ctrl-icon-filter: brightness(0) invert(1);
  --cc-map-scale-bg: rgba(26, 26, 46, 0.85);
  --cc-map-scale-border: rgba(255, 255, 255, 0.7);
  --cc-map-scale-text: #ffffff;
  
  /* ── Map visualization ── */
  --cc-snap-color: #00ffcc;
  --cc-hover-highlight: #0066ff;
  --cc-select-highlight: #00aaff;
  --cc-stroke-color: #000000;
  --cc-stroke-light: #ffffff;
  --cc-text-halo: #000000;
  --cc-text-halo-alt: #1a1a2e;
  --cc-station-default: #4ecdc4;
  --cc-gray-line: #888888;
  --cc-gray-text: #aaa;
  --cc-grid-default: #333366;
  --cc-zero-datum: #ffd700;
  --cc-compass-color: #ffcc00;
  --cc-depth-shallow: #00bfff;
  --cc-depth-deep: #ff4444;
  --cc-depth-text: rgba(255, 255, 255, 0.7);
  
  /* ── Canvas preview ── */
  --cc-preview-bg: #1a1a2e;
  --cc-preview-text: #ffffff;
  
  /* ── Opacity variants ── */
  --cc-background-80: rgba(26, 26, 46, 0.8);
  --cc-panel-50: rgba(22, 33, 62, 0.5);
  --cc-panel-90: rgba(22, 33, 62, 0.9);
  --cc-accent-10: rgba(78, 205, 196, 0.1);
  --cc-accent-20: rgba(78, 205, 196, 0.2);
  --cc-accent-90: rgba(78, 205, 196, 0.9);
  --cc-warning-10: rgba(255, 203, 119, 0.1);
  --cc-warning-30: rgba(255, 203, 119, 0.3);
  /* Additional opacity variants as determined by grep scan */
  
  color-scheme: dark;
}
```

### Light theme
```css
[data-theme="light"] {
  /* ── Surface colors ── */
  --cc-background: #f5f0e8;
  --cc-panel: #ffffff;
  --cc-border: #d4c5a9;
  
  /* ── Text colors ── */
  --cc-text-primary: #1a120b;
  --cc-text-secondary: #6b5b4a;
  
  /* ── Semantic colors ── */
  --cc-accent: #3a8a82;
  --cc-accent-on: #ffffff;
  --cc-warning: #c4901a;
  --cc-error: #c44040;
  --cc-success: #2a7a6a;
  
  /* ── Interactive states ── */
  --cc-hover: rgba(58, 138, 130, 0.08);
  --cc-focus-ring: #3a8a82;
  --cc-focus-glow: rgba(58, 138, 130, 0.4);
  
  /* ── Scrollbar ── */
  --cc-scrollbar-track: #ebe4d8;
  --cc-scrollbar-thumb: #c1a07a;
  --cc-scrollbar-hover: #3a8a82;
  
  /* ── Form controls ── */
  --cc-input-bg: #ffffff;
  --cc-input-border: #d4c5a9;
  
  /* ── DatePicker ── */
  --cc-outside-month: #aaa;
  
  /* ── Selection indicator ── */
  --cc-selection-gradient: rgba(58, 138, 130, 0.2);
  
  /* ── MapLibre controls ── */
  --cc-map-ctrl-bg: #ffffff;
  --cc-map-ctrl-border: #d4c5a9;
  --cc-map-ctrl-hover: #f5f0e8;
  --cc-map-ctrl-active: #ebe4d8;
  --cc-map-ctrl-icon-filter: none;
  --cc-map-scale-bg: rgba(255, 255, 255, 0.9);
  --cc-map-scale-border: rgba(0, 0, 0, 0.5);
  --cc-map-scale-text: #1a120b;
  
  /* ── Map visualization ── */
  --cc-snap-color: #00cc99;
  --cc-hover-highlight: #0055dd;
  --cc-select-highlight: #0088cc;
  --cc-stroke-color: #000000;
  --cc-stroke-light: #333333;
  --cc-text-halo: #ffffff;
  --cc-text-halo-alt: #f5f0e8;
  --cc-station-default: #2a8a80;
  --cc-gray-line: #999999;
  --cc-gray-text: #777;
  --cc-grid-default: #c1a07a;
  --cc-zero-datum: #cc9900;
  --cc-compass-color: #cc9900;
  --cc-depth-shallow: #0099cc;
  --cc-depth-deep: #cc3333;
  --cc-depth-text: rgba(0, 0, 0, 0.7);
  
  /* ── Canvas preview ── */
  --cc-preview-bg: #f5f0e8;
  --cc-preview-text: #1a120b;
  
  /* ── Opacity variants ── */
  --cc-background-80: rgba(245, 240, 232, 0.8);
  --cc-panel-50: rgba(255, 255, 255, 0.5);
  --cc-panel-90: rgba(255, 255, 255, 0.9);
  --cc-accent-10: rgba(58, 138, 130, 0.1);
  --cc-accent-20: rgba(58, 138, 130, 0.2);
  --cc-accent-90: rgba(58, 138, 130, 0.9);
  --cc-warning-10: rgba(196, 144, 26, 0.1);
  --cc-warning-30: rgba(196, 144, 26, 0.3);
  
  color-scheme: light;
}
```

## Acceptance

- [ ] `:root, [data-theme="dark"]` block defines ALL `--cc-*` variables (60+)
- [ ] `[data-theme="light"]` block defines ALL same variables with light theme values
- [ ] Both blocks include `color-scheme` property
- [ ] Dark theme values match existing hardcoded values exactly
- [ ] Light theme values are WCAG AA compliant (4.5:1 text contrast)
- [ ] Map visualization light values are visible on light backgrounds
- [ ] Opacity variants are defined for all Tailwind modifier patterns found in codebase
- [ ] Variables placed after @tailwind directives, before base styles
- [ ] No existing styles broken (this task only adds new CSS, doesn't replace yet)
