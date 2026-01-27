# Style MapLibre Controls to Match App Dark Theme

## Overview
Restyle MapLibre GL JS built-in controls (NavigationControl zoom +/-, ScaleControl scale bar) to match CaveChef's dark theme. Both MapCanvas (single-system view) and GlobalViewMap (global view) are affected. All controls currently use MapLibre's default light theme (white backgrounds, dark text) which clashes with the dark UI.

## Scope
- **CSS overrides** in `src/index.css` for all `.maplibregl-ctrl` elements
- **Both map views**: MapCanvas and GlobalViewMap (CSS-only, no component code changes)
- **Controls**: NavigationControl (zoom +/-), ScaleControl (scale bar), broad selectors for future controls
- **E2E tests**: Computed style assertions verifying dark theme colors

## Approach

### CSS Strategy
Follow the **React DatePicker override pattern** already established at `src/index.css:194-246`:
- Raw CSS with hardcoded hex values matching design tokens
- Use `!important` where needed to override MapLibre defaults (MapLibre CSS has moderate specificity)
- Add a new `/* MapLibre controls - dark theme */` section after the DatePicker section
- **Do NOT use `@apply`** — existing codebase convention uses raw CSS for third-party overrides

### Design Token Reference
| Token | Hex | Usage |
|-------|-----|-------|
| panel | #16213e | Control backgrounds |
| border | #0f3460 | Borders, dividers, hover bg |
| text-primary | #f5f5f5 | Text, icon fills |
| accent | #4ecdc4 | Focus ring (already global) |
| background | #1a1a2e | Active state bg |

### Key MapLibre Selectors
- `.maplibregl-ctrl-group` — zoom button wrapper (override: background, border-radius, box-shadow)
- `.maplibregl-ctrl-group button` — individual buttons (override: background on hover/active)
- `.maplibregl-ctrl-group button + button` — divider between buttons (override: border-top color)
- `.maplibregl-ctrl-icon` — SVG icons (override: filter to invert for dark bg)
- `.maplibregl-ctrl-scale` — scale bar (override: background transparent, border/text colors)
- `.maplibregl-ctrl` — broad catch-all for future controls

### Icon Handling
MapLibre icons use embedded SVG data URLs with `#333` fill. Use `filter: brightness(0) invert(1)` on `.maplibregl-ctrl-icon` to make them white — this is the standard approach used by multiple production MapLibre dark theme implementations (meshtastic, electricitymaps, openindoormaps).

### Focus Ring
Already handled by global `*:focus-visible` rule at `src/index.css:38-41` (2px solid #4ecdc4, offset 2px). No additional focus styling needed for MapLibre controls — the global rule applies.

### Testing
Use WebdriverIO `browser.execute(getComputedStyle)` pattern consistent with existing tests:
- `section-highlighting-a11y.spec.ts:301-304` — backgroundColor assertion pattern
- `shortcuts-accessibility.spec.ts:766-772` — multi-property style collection pattern
- `export-accessibility.spec.ts:388-397` — focus indicator verification pattern
No screenshot/visual regression tests (none exist in codebase).

## Risks
- **MapLibre CSS specificity**: May need `!important` — mitigated by following DatePicker pattern
- **SVG icon data URLs**: MapLibre may change icon format in upgrades — mitigated by using `filter` instead of replacing data URLs
- **Scale bar dynamic insertion**: MapCanvas toggles ScaleControl on/off — CSS applies to class selectors so works regardless of DOM timing

## Quick commands
```bash
# Dev server
./scripts/dev.sh

# Type check
pnpm tsc --noEmit

# E2E tests
pnpm test:ui
```

## Acceptance
- [ ] Zoom +/- buttons use dark theme colors (bg-panel, border-border, text-primary) in both views
- [ ] Zoom buttons visually match Fit to View button style (colors, border, rounded corners)
- [ ] Hover/active states on zoom buttons use themed colors
- [ ] Focus ring uses accent teal via existing global :focus-visible rule
- [ ] Divider between + and - buttons uses border color (#0f3460)
- [ ] Scale bar: transparent background, border color line, text-primary text, L-shaped style preserved
- [ ] Scale bar font matches application font-family
- [ ] SVG icons in zoom buttons are light-colored on dark background
- [ ] All CSS overrides in src/index.css following React DatePicker pattern (raw CSS + !important)
- [ ] Broad .maplibregl-ctrl selectors ensure future controls inherit dark theme
- [ ] E2E tests verify computed styles for key control properties
- [ ] Existing E2E tests continue to pass
- [ ] No MapLibre control functionality broken (buttons clickable, scale bar updates)

## References
- Existing DatePicker pattern: `src/index.css:194-246`
- Fit to View button: `src/components/Map/MapCanvas.tsx:1784-1792`
- MapCanvas NavigationControl: `src/components/Map/MapCanvas.tsx:582-585`
- GlobalViewMap NavigationControl: `src/components/GlobalView/GlobalViewMap.tsx:413-416`
- MapCanvas ScaleControl: `src/components/Map/MapCanvas.tsx:588-589`
- GlobalViewMap ScaleControl: `src/components/GlobalView/GlobalViewMap.tsx:419-422`
- Global focus-visible rule: `src/index.css:38-41`
- Design tokens: `tailwind.config.js:16-26`
- GitHub examples: meshtastic/network-management-client, electricitymaps/electricitymaps-contrib, openindoormaps
