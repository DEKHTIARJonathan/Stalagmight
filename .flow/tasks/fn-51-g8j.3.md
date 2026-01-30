# fn-51-g8j.3 Migrate all hardcoded colors in index.css to CSS variables

## Description

Replace every hardcoded hex color in `src/index.css` (scrollbar, focus, inputs, checkboxes, tables, selection indicator, DatePicker, MapLibre controls) with the corresponding `var(--cc-*)` reference.

## Files to modify

- `src/index.css` — Replace all hardcoded hex colors with CSS variable references

## Implementation

Systematic replacement of every hardcoded color:

### Scrollbar
- `#16213e` → `var(--cc-scrollbar-track)`
- `#0f3460` → `var(--cc-scrollbar-thumb)`
- `#4ecdc4` → `var(--cc-scrollbar-hover)`

### Focus styles
- `#4ecdc4` → `var(--cc-focus-ring)`

### Input/select/textarea
- `background-color: #16213e` → `var(--cc-input-bg)`
- `border: 1px solid #0f3460` → `var(--cc-input-border)`
- `color: #f5f5f5` → `var(--cc-text-primary)`
- `border-color: #4ecdc4` → `var(--cc-accent)`

### Checkbox/radio
- `background-color: #16213e` → `var(--cc-input-bg)`
- `border: 1px solid #0f3460` → `var(--cc-input-border)`
- `background-color: #4ecdc4` / `border-color: #4ecdc4` → `var(--cc-accent)`
- `border: solid #1a1a2e` (checkmark) → `var(--cc-accent-on)`
- `background-color: #1a1a2e` (radio dot) → `var(--cc-accent-on)`
- `border-color: #4ecdc4` (hover) → `var(--cc-accent)`
- `rgba(78, 205, 196, 0.5)` (focus glow) → `var(--cc-focus-glow)`

### color-scheme
- `color-scheme: dark` on `select, input[type="date"]` → remove (handled by root-level `color-scheme` in theme block)

### Table styles
- `#0f3460` → `var(--cc-border)`
- `#16213e` → `var(--cc-panel)`
- `rgba(78, 205, 196, 0.1)` → `var(--cc-hover)`

### Selection indicator
- `rgba(78, 205, 196, 0.3)` → `var(--cc-selection-gradient)`

### React DatePicker
- `#1a1a2e` → `var(--cc-background)`
- `#16213e` → `var(--cc-panel)`
- `#0f3460` → `var(--cc-border)`
- `#f5f5f5` → `var(--cc-text-primary)`
- `#4ecdc4` → `var(--cc-accent)`
- `#1a1a2e` (selected day text) → `var(--cc-accent-on)`
- `#666` → `var(--cc-outside-month)`

### MapLibre controls
- `#f5f5f5` → `var(--cc-text-primary)`
- `#16213e` → `var(--cc-map-ctrl-bg)`
- `#0f3460` → `var(--cc-map-ctrl-border)`
- `#1a1a2e` → `var(--cc-map-ctrl-hover)`
- `#0f3460` (active) → `var(--cc-map-ctrl-active)`
- `brightness(0) invert(1)` → `var(--cc-map-ctrl-icon-filter)`
- Scale control: use `--cc-map-scale-bg`, `--cc-map-scale-border`, `--cc-map-scale-text`
- `rgba(15, 52, 96, 0.3)` (box-shadow) → use `var(--cc-map-ctrl-border)` with appropriate opacity

## Acceptance

- [ ] Zero hardcoded hex color values remain in index.css (except in the theme definition blocks themselves)
- [ ] All `var(--cc-*)` references resolve to correct variables defined in task 1
- [ ] `color-scheme: dark` removed from individual selectors (now on :root)
- [ ] App renders identically in dark theme (pixel-perfect with current state)
- [ ] DatePicker renders correctly with CSS variables
- [ ] MapLibre controls render correctly
- [ ] Scrollbar styled correctly
- [ ] Focus rings visible and correct color
