# fn-51-g8j.7 Handle MapLibre controls and third-party widget theming

## Description

Ensure MapLibre map controls and React DatePicker render correctly in both dark and light themes. The icon inversion filter on MapLibre control icons must be conditional.

## Files to modify

- `src/index.css` — Already migrated to CSS variables in task 3, but verify MapLibre-specific adjustments
- Any MapLibre-related components that apply inline styles

## Implementation

### MapLibre icon filter

In task 1, the `--cc-map-ctrl-icon-filter` variable is defined as:
- Dark: `brightness(0) invert(1)` (inverts dark icons to white)
- Light: `none` (icons are already dark, no inversion needed)

The index.css rule `.maplibregl-ctrl-icon { filter: ... }` was migrated in task 3 to use `var(--cc-map-ctrl-icon-filter)`.

This task verifies the result works correctly and handles any edge cases:

1. **Verify MapLibre control buttons** render with correct background/border in both themes
2. **Verify scale control** text is readable in both themes
3. **Check for inline styles** in any MapLibre wrapper components that override CSS
4. **Check MapLibre popup/tooltip styles** if any exist

### React DatePicker

The DatePicker overrides were migrated in task 3. This task verifies:
1. Calendar popup background contrasts with page
2. Selected day and today indicators visible
3. Navigation arrows visible
4. Outside-month days are dimmed appropriately

### Other third-party widgets

Search for any other third-party components with hardcoded dark theme overrides and convert them.

## Acceptance

- [ ] MapLibre zoom/compass controls render correctly in dark theme
- [ ] MapLibre zoom/compass controls render correctly in light theme  
- [ ] MapLibre control icons are visible (not invisible) in both themes
- [ ] Scale control text is readable in both themes
- [ ] DatePicker calendar renders correctly in dark theme
- [ ] DatePicker calendar renders correctly in light theme
- [ ] No hardcoded hex colors remain in third-party widget overrides (except in theme blocks)
- [ ] No inline styles in components override theme variables for third-party widgets

## Done summary
Verified MapLibre controls and DatePicker third-party widget theming for both dark and light themes. All .maplibregl-* and .react-datepicker* CSS rules use var(--cc-*) tokens. Fixed text-foreground (undefined Tailwind token) to text-text-primary in DatePicker.tsx and Select.tsx. Renamed dark-calendar/dark-popper class names to theme-neutral cc-calendar/cc-popper. No other third-party widgets with hardcoded dark theme overrides found.
## Evidence
- Commits:
- Tests:
- PRs: