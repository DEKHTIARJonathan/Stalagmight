# fn-51-g8j.8 Update default color palettes for light theme in DisplaySettings

## Description

When the active theme is light, the default color palettes offered in DisplaySettings (background color, grid color, font color, section colors) should be appropriate for a light background. The theme influences what defaults are shown, but users can still pick any color.

## Files to modify

- `src/types/config.ts` — Add light-theme default palette constants or a function that returns defaults per theme
- `src/components/Dialogs/settings/DisplaySettings.tsx` — Use theme-aware defaults in the "Reset to defaults" flow
- `src/components/Dialogs/SettingsDialog.tsx` — Pass theme context to `getCategoryDefaults()` for the display category

## Implementation

### Approach

When the user clicks "Reset to defaults" on the Display tab, the defaults should match the current theme:

- **Dark theme defaults** (existing values):
  - Background: `#1a1a2e`
  - Grid: `#333366`  
  - Font color: `#f5f5f5`
  - Section palette: existing 8 colors

- **Light theme defaults**:
  - Background: `#f5f0e8`
  - Grid: `#c1a07a`
  - Font color: `#1a120b`
  - Section palette: adjusted for light backgrounds (darker/more saturated versions)

### Implementation detail

Add a helper function:
```typescript
export function getDisplayDefaults(theme: 'dark' | 'light'): Partial<DisplayConfig> {
  if (theme === 'light') {
    return {
      background_color: '#f5f0e8',
      grid_color: '#c1a07a',
      font_color: '#1a120b',
      // ... other display defaults for light
    };
  }
  return { /* existing dark defaults */ };
}
```

The `getCategoryDefaults('display')` in SettingsDialog should call this with the current resolved theme.

**Note**: This does NOT auto-change display settings when switching themes. It only affects what "Reset to defaults" produces. Users' existing display customizations are preserved.

## Acceptance

- [ ] "Reset to defaults" on Display tab produces dark-appropriate colors when theme is dark
- [ ] "Reset to defaults" on Display tab produces light-appropriate colors when theme is light
- [ ] Switching themes does NOT auto-change existing display settings
- [ ] Light theme section palette colors are visually distinct on light backgrounds
- [ ] `pnpm tsc --noEmit` passes

## Done summary

(To be filled on completion)

## Evidence

(To be filled on completion)
