# fn-51-g8j.6 Create AppearanceSettings tab and wire into SettingsDialog

## Description

Create a new Appearance settings tab component and integrate it into the existing Settings dialog infrastructure.

**Size:** M
**Files:**
- `src/components/Dialogs/settings/AppearanceSettings.tsx` (new)
- `src/components/Dialogs/SettingsSidebar.tsx` — Add 'appearance' to `SettingsCategory` type union AND `CATEGORIES` array
- `src/components/Dialogs/SettingsDialog.tsx` — Import and render AppearanceSettings, add to category switch logic

## Approach

- Follow the existing `SettingsCategoryProps` pattern from `src/components/Dialogs/settings/types.ts`
- **IMPORTANT**: `SettingsCategory` type is defined in `src/components/Dialogs/SettingsSidebar.tsx` (NOT in a `settings/` subdirectory). The `CATEGORIES` array is also in this file.
- Place Appearance tab second in the sidebar (after General, before Units)
- Theme selector: radio group with Dark / Light / Auto options, each with description
- Import `SettingsCategoryProps` from `./settings/types` (relative to Dialogs/)

## Key context

- `SettingsSidebar.tsx` is at `src/components/Dialogs/SettingsSidebar.tsx`, NOT `src/components/Dialogs/settings/SettingsSidebar.tsx`
- `SettingsCategoryProps` is exported from `src/components/Dialogs/settings/types.ts`
- Follow existing settings tab components (e.g. GeneralSettings, UnitsSettings) for layout patterns using `SettingsSection` and `SettingRow`

## Acceptance

- [ ] `SettingsCategory` type in `src/components/Dialogs/SettingsSidebar.tsx` includes `'appearance'`
- [ ] `CATEGORIES` array in same file includes `{ id: 'appearance', label: 'Appearance' }`
- [ ] Appearance tab appears in Settings sidebar (second position, after General)
- [ ] Tab shows theme selector with Dark, Light, Auto options
- [ ] Each option has a description label
- [ ] Selecting a theme updates config via `onChange()`
- [ ] Changed field highlighting works (shows modified indicator)
- [ ] "Reset to defaults" works for Appearance category
- [ ] `pnpm tsc --noEmit` passes
- [ ] Tab follows existing SettingsCategoryProps pattern exactly
- [ ] ARIA: radio group has proper role and labeling

## Done summary

(To be filled on completion)

## Evidence

(To be filled on completion)
