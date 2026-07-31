# UI Style Guide

This guide captures the current UI conventions and design tokens for Stalagmight.

## Design Tokens
- Source of truth: `src/theme/tokens.ts`, applied as CSS variables in `src/index.css`.
- Use token-backed utility classes (examples): `bg-panel`, `bg-background`, `text-text-primary`, `text-text-secondary`, `border-border`, `bg-accent`, `text-accent-on`, `text-warning`, `text-error`, `text-success`.
- Opacity variants are available as token utilities (examples): `bg-accent-10`, `bg-accent-20`, `bg-background-50`.

## Colors
- **No color value ships without a human seeing it rendered.** Measure and propose; do not merge. Covers `--cc-*` tokens on all 8 themes, display defaults in `src/types/config.ts`, section palettes, and renderer/export constants.
- Contrast and CIEDE2000 numbers are evidence for that review, not a substitute: the legibility harness scores endpoint distance, which lightness dominates, so washing a color out *raises* its score.
- If a test rejects an approved color, the test is wrong.
- Depth ramp direction is load-bearing: `getDepthColor` walks the shortest HSL hue path, so a shallow anchor at hue >= 180 inverts the theme. Anchors sit below 180; `SHALLOW_HUE.max` is 178.
- Light canvases hold a 2:1 ramp contrast floor, not 3:1 - the yellow midpoint is the ramp's brightest sample, and 3:1 on near-white reads olive-brown.
- Outstanding measurements: [#380](https://github.com/Stalagmight/Stalagmight/issues/380).

## Typography
- Defaults are inherited from the app shell. Use consistent size tiers:
  - `text-xs` for metadata and hints.
  - `text-sm` for standard body content.
  - `text-lg` and `text-xl` for headers and primary titles.
- Use `font-medium` for section headers and `font-semibold` for key titles.

## Buttons
- `Button` variants:
  - `primary`: the single main action in a view or dialog.
  - `secondary`: default action style.
  - `ghost`: low-emphasis actions in dense UI or toolbars.
  - `danger`: destructive actions.
- Use `icon` on `Button` for leading icons.
- Use `IconButton` for icon-only actions; always include `aria-label` and, when helpful, `tooltip`.

## Icons
- Use SVG icons from `src/components/common/icons.tsx`.
- Default size is 16px; use 14px in dense toolbars and 20px+ for empty states or emphasis.
- Icons inherit color via `currentColor` and should follow surrounding text color utilities.
- Avoid emoji or text glyphs for icons to keep the system replaceable.

## Panels and Layout
- Use `Panel` for bordered, titled groups.
- Use `ResizablePanel` for split panes and adjustable sidebars.
- Common header spacing: `px-3 py-2` with `border-b border-border`.

## Tables and Lists
- Use `SpreadsheetGrid` for tabular survey data, read-only or editable (the
  in-house grid; see `src/components/common/SpreadsheetGrid/README.md`).
  `ShotTableEditor` is the shot table embedded in dialogs.
- Selection uses a persistent indicator (`selected-cell-indicator`) and a `bg-accent-20` row tint.
- Hover states should be lighter (`bg-accent-10`) than selection.

## Forms
- Inputs should use themed backgrounds and borders (`bg-panel`, `border-border`) and a visible focus ring (`focus:ring-1 focus:ring-accent`).
- Prefer shared components like `Select` and `DatePicker` for consistent behavior.

## Accessibility
- Icon-only buttons must include `aria-label`.
- Keep `data-testid` attributes consistent for UI tests.
