# fn-51-g8j.8 Update default color palettes for light theme in DisplaySettings

## Description

When the active theme is light, the default color palettes offered in DisplaySettings (background color, grid color, font color, section colors) should be appropriate for a light background. The theme influences what defaults are shown, but users can still pick any color.

**Size:** M
**Files:**
- `src/types/config.ts` — Add light-theme default palette constants or helper function
- `src/components/Dialogs/settings/DisplaySettings.tsx` — Use theme-aware defaults in "Reset to defaults" flow
- `src/components/Dialogs/SettingsDialog.tsx` — Pass theme context to `getCategoryDefaults()` for display category

## Approach

When the user clicks "Reset to defaults" on the Display tab, the defaults should match the current theme:

- **Dark theme defaults** (existing values):
  - `default_background`: `#1a1a2e`
  - `grid_color`: `#333366`
  - `font_color`: `#f5f5f5`
  - Section palette: existing 8 colors

- **Light theme defaults**:
  - `default_background`: `#f5f0e8`
  - `grid_color`: `#c1a07a`
  - `font_color`: `#1a120b`
  - Section palette: adjusted for light backgrounds (darker/more saturated)

**NOTE**: Config field names are `default_background`, `grid_color`, `font_color` (as defined in `DisplayConfig` interface in `src/types/config.ts`).

This does NOT auto-change display settings when switching themes. It only affects what "Reset to defaults" produces. Users' existing display customizations are preserved.

## Key context

- `getCategoryDefaults('display')` in SettingsDialog.tsx needs to call a theme-aware helper with the current `resolvedTheme`
- Config field names: `display.default_background`, `display.grid_color`, `display.font_color`, `display.depth_gradient.shallow_color`, `display.depth_gradient.deep_color`
- The resolved theme is available from `useUIStore((s) => s.resolvedTheme)` (set by `useTheme` hook in task 5)

## Acceptance

- [ ] "Reset to defaults" on Display tab produces dark-appropriate colors when theme is dark
- [ ] "Reset to defaults" on Display tab produces light-appropriate colors when theme is light
- [ ] Helper uses correct field names: `default_background`, `grid_color`, `font_color` (matching `DisplayConfig`)
- [ ] Switching themes does NOT auto-change existing display settings
- [ ] Light theme section palette colors are visually distinct on light backgrounds
- [ ] `pnpm tsc --noEmit` passes

## Done summary

(To be filled on completion)

## Evidence

(To be filled on completion)
