# fn-35-v6w.1 Add MapLibre control dark theme CSS overrides

## Description

Add CSS overrides in `src/index.css` to restyle all MapLibre GL JS built-in controls to match CaveChef's dark theme. This is a CSS-only change — no component code modifications needed.

**Size:** M
**Files:** `src/index.css`

## Approach

Follow the React DatePicker override pattern at `src/index.css:194-246`:
- Raw CSS with hardcoded hex values matching design tokens
- `!important` where needed to override MapLibre defaults
- Add new section after the DatePicker overrides (after line 246)

### Controls to Style

**NavigationControl (zoom +/- buttons):**
- `.maplibregl-ctrl-group`: background `#16213e` (panel), border `1px solid #0f3460`, `border-radius: 4px`
- `.maplibregl-ctrl-group button`: hover `#1a1a2e` (background), active `#0f3460` (border)
- `.maplibregl-ctrl-group button + button`: border-top color `#0f3460` (divider)
- `.maplibregl-ctrl-icon`: `filter: brightness(0) invert(1)` to make SVG icons white
- Box shadow: `0 0 0 2px rgba(15, 52, 96, 0.3)` (subtle themed shadow replacing MapLibre default)

**ScaleControl (scale bar):**
- `.maplibregl-ctrl-scale`: transparent background, border-color `#0f3460`, color `#f5f5f5`, font-family inherit
- Keep L-shaped cartographic style (border-width: medium 2px 2px, border-style: none solid solid)

**Broad selectors for future controls:**
- `.maplibregl-ctrl`: base color/font overrides so future controls auto-inherit

### Button Sizing
Match Fit to View button dimensions. Fit to View uses `px-2 py-1 text-sm` (see `MapCanvas.tsx:1784-1792`). MapLibre default is 29x29px — keep this or adjust to match Fit to View padding.

### Reference Patterns
- React DatePicker overrides: `src/index.css:194-246`
- Global focus-visible rule: `src/index.css:38-41` (already covers MapLibre buttons)
- GitHub examples: meshtastic/network-management-client (comprehensive dark theme), electricitymaps (Tailwind dark mode)

## Key context

- MapLibre CSS is loaded from the npm package — overrides in `src/index.css` come after it in the build pipeline, but may need `!important` for specificity
- MapLibre icons use embedded SVG data URLs with `#333` fill — do NOT replace data URLs, use CSS `filter` instead
- ScaleControl is dynamically added/removed in MapCanvas based on `showScaleBar` state — CSS class selectors work regardless of DOM timing
- The global `*:focus-visible` rule already provides teal focus rings — no additional focus styling needed
- Do NOT use `@apply` — the codebase convention for third-party overrides is raw CSS (see DatePicker section)
## Acceptance
- [ ] New "MapLibre controls - dark theme" section added in `src/index.css` after React DatePicker section
- [ ] `.maplibregl-ctrl-group` has panel background (#16213e), border (#0f3460), rounded corners
- [ ] `.maplibregl-ctrl-group button` hover state uses background color (#1a1a2e)
- [ ] `.maplibregl-ctrl-group button + button` divider uses border color (#0f3460)
- [ ] `.maplibregl-ctrl-icon` uses filter to invert SVG icons for dark background
- [ ] `.maplibregl-ctrl-scale` has transparent background, border color (#0f3460), text-primary (#f5f5f5), inherited font-family
- [ ] Scale bar retains L-shaped cartographic style
- [ ] Broad `.maplibregl-ctrl` selector provides base dark theme for future controls
- [ ] Box shadow uses themed color instead of MapLibre default
- [ ] Follows React DatePicker pattern: raw CSS, hardcoded hex values, !important where needed
- [ ] `pnpm tsc --noEmit` passes
- [ ] Zoom buttons are visually clickable and functional in both MapCanvas and GlobalViewMap
- [ ] Scale bar updates correctly when zooming in both views
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
