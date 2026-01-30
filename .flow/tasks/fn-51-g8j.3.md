# fn-51-g8j.3 Migrate all hardcoded colors in index.css to CSS variables

## Description

Replace every hardcoded hex color in `src/index.css` (scrollbar, focus, inputs, checkboxes, tables, selection indicator, DatePicker, MapLibre controls) with the corresponding `var(--cc-*)` reference. Use explicit alpha tokens for all rgba values — do NOT use `color-mix()`.

**Size:** M
**Files:** `src/index.css`

## Approach

- Systematic replacement of every hardcoded color in index.css
- For rgba values used in shadows (e.g. MapLibre control `box-shadow: rgba(15, 52, 96, 0.3)`), use explicit alpha tokens like `var(--cc-map-ctrl-shadow)` — do NOT try to apply opacity to a `var()` reference
- Remove `color-scheme: dark` from individual selectors (now handled by root-level `color-scheme` in theme block from task 1)
- Follow existing pattern at `src/index.css` for selector specificity

## Key context

- CSS cannot apply alpha to an arbitrary hex `var()` without `color-mix()` or explicit tokens
- This plan uses explicit alpha tokens for all shadow/overlay rgba values
- `--cc-map-ctrl-shadow` is defined in task 1 for the MapLibre control box-shadow

## Acceptance

- [ ] Zero hardcoded hex color values remain in index.css (except in the theme definition blocks themselves)
- [ ] All `var(--cc-*)` references resolve to correct variables defined in task 1
- [ ] All rgba shadow values use explicit alpha tokens (not `color-mix()`)
- [ ] `color-scheme: dark` removed from individual selectors (now on :root)
- [ ] App renders identically in dark theme (pixel-perfect with current state)
- [ ] DatePicker renders correctly with CSS variables
- [ ] MapLibre controls render correctly (including box-shadow)
- [ ] Scrollbar styled correctly
- [ ] Focus rings visible and correct color

## Done summary

(To be filled on completion)

## Evidence

(To be filled on completion)
