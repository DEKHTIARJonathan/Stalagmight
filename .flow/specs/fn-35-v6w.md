# Style MapLibre Controls to Match App Dark Theme

## Problem
The MapLibre GL JS built-in controls (NavigationControl zoom +/- buttons, ScaleControl scale bar) use MapLibre's default light theme (white backgrounds, dark text, light borders) which visually clashes with CaveChef's dark theme. This affects both the single-system MapCanvas view and the GlobalView map.

## Key Decisions

- **Match existing Fit to View button style**: The zoom +/- buttons should use the same `bg-panel`, `border-border`, `rounded` treatment as the existing Fit to View (⊞) button in MapCanvas.
- **Hover/active states follow app convention**: Use existing design convention for hover/active states on buttons.
- **Icon colors follow app convention**: SVG +/- icons should use whatever color treatment matches existing interactive elements.
- **Divider between + and - buttons**: The separator line between zoom-in and zoom-out should use the border color (#0f3460).
- **Box shadow follows app convention**: Match whatever shadow treatment other panels/buttons in the app use.
- **Scale bar: transparent with themed colors**: No background panel; just change the scale line to border color and text to text-primary. Keep the standard cartographic L-shaped bar.
- **Scale bar font**: Match the application's font-family.
- **Button size**: Resize zoom buttons to match the Fit to View button's padding/dimensions.
- **Button position**: Zoom buttons stay at top-right, Fit to View stays at top-left — no repositioning.
- **Broad selectors for future-proofing**: Style all `.maplibregl-ctrl` elements so any future MapLibre controls automatically inherit the dark theme.
- **All MapLibre controls**: Restyle any MapLibre built-in control that appears (current or future), not just zoom and scale.
- **CSS location**: Add overrides in `src/index.css` using Tailwind `@apply` with design tokens.
- **Transitions**: Match existing app button transition conventions.
- **Focus ring**: Accent teal (#4ecdc4) outline/ring on keyboard focus for accessibility.
- **Testing**: Add visual checks (screenshot comparison or computed style assertions) to verify the dark theme styling is applied correctly.

## Scope

### Both Map Views Affected
1. **MapCanvas** (`src/components/Map/MapCanvas.tsx`) — single system view, NavigationControl at top-right, ScaleControl toggled via Display menu at bottom-left
2. **GlobalViewMap** (`src/components/GlobalView/GlobalViewMap.tsx`) — global view, NavigationControl at top-right, ScaleControl always visible at bottom-left

### Controls to Style
- `.maplibregl-ctrl-group` — zoom button wrapper
- `.maplibregl-ctrl-group button` — individual zoom buttons (+/-)
- `.maplibregl-ctrl-zoom-in` / `.maplibregl-ctrl-zoom-out` — specific zoom buttons
- `.maplibregl-ctrl-scale` — scale bar
- `.maplibregl-ctrl` — broad selector for all current and future controls
- SVG icons inside buttons (fill color)
- Button separator/divider line

### Theme Colors (Design Tokens)
- Panel background: `bg-panel` (#16213e)
- Border: `border` (#0f3460)
- Text: `text-primary` (#f5f5f5)
- Accent: `accent` (#4ecdc4)
- Background: `background` (#1a1a2e)

### Reference: Existing Fit to View Button Style
```
className="absolute top-2 left-2 bg-panel border border-border rounded px-2 py-1 text-sm hover:bg-background"
```

## Edge Cases
- Scale bar text must remain readable over any map background (dark satellite imagery, light terrain, etc.)
- SVG icon fill must override MapLibre's default black fill
- MapLibre control CSS has moderate specificity — overrides may need sufficient specificity or `!important` in limited cases
- The scale bar is dynamically added/removed in MapCanvas based on `showScaleBar` state — CSS must work when the element is re-added to the DOM
- Future MapLibre controls (attribution, geolocate, etc.) should automatically inherit the dark theme via broad selectors
- The MapLibre CSS is loaded from the npm package — overrides must come after it in the cascade

## Open Questions
- Exact computed dimensions of the Fit to View button to match zoom button sizing
- Whether `@layer components` provides enough specificity to override MapLibre defaults or if specificity needs to be boosted
- What visual check approach to use for E2E tests (screenshot comparison vs computed style assertions)

## Acceptance
- [ ] Zoom +/- buttons in both MapCanvas and GlobalViewMap use dark theme colors (bg-panel, border-border, text-primary)
- [ ] Zoom buttons match the Fit to View button's visual style (colors, border, rounded corners, sizing)
- [ ] Hover/active/focus states on zoom buttons follow app conventions
- [ ] Focus ring uses accent teal color for keyboard accessibility
- [ ] Divider between + and - buttons uses border color
- [ ] Scale bar line uses border color, text uses text-primary, no background
- [ ] Scale bar keeps L-shaped cartographic style
- [ ] Scale bar font matches application font-family
- [ ] SVG icons in zoom buttons use themed colors
- [ ] All CSS overrides live in src/index.css using @apply with Tailwind tokens
- [ ] Broad .maplibregl-ctrl selectors ensure future controls inherit dark theme
- [ ] Box shadow and transition behavior match app conventions
- [ ] E2E tests include visual checks verifying dark theme styling
- [ ] Existing functional E2E tests continue to pass
- [ ] No MapLibre control functionality is broken (buttons remain clickable, scale bar updates correctly)
