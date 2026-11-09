# UI Style Guide

This guide captures the current UI conventions and design tokens for Stalagmight.

## Design Tokens
- Source of truth: `src/theme/tokens.ts`, applied as CSS variables in `src/index.css`.
- Use token-backed utility classes (examples): `bg-panel`, `bg-background`, `text-text-primary`, `text-text-secondary`, `border-border`, `bg-accent`, `text-accent-on`, `text-warning`, `text-error`, `text-success`.
- Opacity variants are available as token utilities (examples): `bg-accent-10`, `bg-accent-20`, `bg-background-50`.
- Warning prose takes `text-warning-text`, not `text-warning`: `--cc-warning` is tuned as a fill (highlight button, stripes) and is too pale for text on the light themes. `--cc-warning-text` reads at WCAG AA on the panel, the background and the `bg-warning-10` / `bg-warning-20` washes in every theme (pinned in `tokens.test.ts`).
- Button tones follow the same split. Per tone (`accent`, `success`, `warning`, `error`, `info`, `external`): the fill, `-on` (text on the fill), `-90` (filled hover), `-text` (label and border of the outline form; AA on the panel, the background and the `-10` / `-20` washes) and the washes. `neutral` has `-border`, `-text`, `-10` and `-20`. Tailwind exposes them as `bg-info`, `text-info-text`, `border-neutral-border` and so on; `neutral` alone stays Tailwind's grey palette.

## Colors
- **No color value ships without a human seeing it rendered.** Measure and propose; do not merge. Covers `--cc-*` tokens on all 10 themes, display defaults in `src/types/config.ts`, section palettes, and renderer/export constants.
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
  - `primary`: the single main action in a view or dialog, in the theme's accent.
  - `secondary`: default action style.
  - `ghost`: low-emphasis actions in dense UI or toolbars.
  - `highlight`: the main action of a panel that has no `primary`, in the theme's warning yellow with `text-warning-on` (the per-theme dark text that reads at WCAG AA on it). Example: Open project in the home screen's project details. Yellow also marks un-uploaded SpeleoDB changes, so keep it to one such button per view.
  - `danger`: destructive actions (delete, discard, revert). Leaving a project is not destructive (the exit prompt protects un-uploaded work), so Close Project is `neutral`.
  - `warning`: transitions that can replace content (Restore a revision), and recovery actions (Resolve synchronization conflict, Keep a local project).
  - `success`: enabling editing (Resume editing, and signing in to edit).
  - `info`: reload and read-only inspection (Reload Project, View a revision), in the theme's blue.
  - `external`: browser navigation (Open on SpeleoDB, Revision History on SpeleoDB), in the theme's purple, always with an external-link icon.
  - `neutral`: a grey outline for actions that step down or leave (Close Project, Switch to Read Only Mode). Not amber: yellow already means "main action of a panel" and "un-uploaded changes".
- Tone forms. `primary`, `danger`, `warning`, `success`, `info`, `external` each come in two forms built from the tone's tokens (`src/components/common/buttonStyles.ts`):
  - outline (tint): the `-text` colour as label and border on the `-10` wash, `-20` on hover;
  - filled: the tone under its `-on` text, `-90` on hover.
  `filled` on `Button` picks the form. `primary` and `danger` are filled unless told otherwise, the other tones are outlines; `neutral` has no filled form.
- One filled button per state. A view fills only the action that makes sense now; every other action keeps its colour as an outline, so the colour still says what kind of action it is while the fill says which one to take. A view may have no filled button at all. The SpeleoDB tab picks it with `speleoPrimaryAction`: Save Changes while there are changes not yet uploaded, Resume editing when the account can edit, signing in while signed out, none when the access is view-only or when editing with nothing to save.
- Every button colour is a theme token. A raw palette class (`bg-sky-100`, `bg-violet-700`) fails `tokens.test.ts`, which reads the class strings the buttons render with and holds each tone in both forms at WCAG AA (4.5:1 label at rest and on hover, 3:1 border and focus ring) on the panel and the background in every theme. Disabled buttons (opacity 0.5) are exempt under WCAG, and must say why they are disabled in their tooltip instead.
- Labels and confirmations explain the action independently of colour.
- SpeleoDB workspace actions are equal-height, full-width buttons (`workspaceActionClass`).
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
- A `Select` embedded in a `SpreadsheetGrid` cell takes `variant="cell"`: it drops its box and fills the cell, so only the right-edge chevron marks it as a control (see the Plan Cylinders grid's Role column).

## Accessibility
- Icon-only buttons must include `aria-label`.
- Keep `data-testid` attributes consistent for UI tests.
- A resize divider is a WAI-ARIA window splitter, not a decorative div:
  `role="separator"`, `aria-orientation`, `aria-label`, `aria-valuenow/min/max`
  in the same units the drag clamps to, `tabIndex={0}`, and
  `focus:outline-none focus-visible:ring-1 focus-visible:ring-accent`. Arrow
  keys nudge, Shift+Arrow steps coarsely, Home/End jump to the bounds, and the
  keys persist through the same path the drag's release uses (debounced, so a
  burst of taps is one write). `WizardMapPanel` is the reference
  implementation; the SingleSystemView resizers have not been retrofitted yet
  (#396).
