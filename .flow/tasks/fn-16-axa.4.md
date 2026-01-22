# fn-16-axa.4 Create settings category content components

## Description
Create content panel components for each of the 9 settings categories, with proper grouping, help text, and form controls. Migrates existing settings from SettingsDialog tabs.

**Size:** L
**Depends on:** fn-16-axa.1 (Toggle), fn-16-axa.2 (Select)
**Files:**
- `src/components/Dialogs/settings/GeneralSettings.tsx` - New
- `src/components/Dialogs/settings/UnitsSettings.tsx` - New
- `src/components/Dialogs/settings/DisplaySettings.tsx` - New
- `src/components/Dialogs/settings/MapSettings.tsx` - New
- `src/components/Dialogs/settings/ValidationSettings.tsx` - New
- `src/components/Dialogs/settings/ExportSettings.tsx` - New
- `src/components/Dialogs/settings/ShortcutsSettings.tsx` - Migrate from SettingsDialog
- `src/components/Dialogs/settings/CacheSettings.tsx` - Migrate from SettingsDialog
- `src/components/Dialogs/settings/AdvancedSettings.tsx` - New
- `src/components/Dialogs/settings/SettingsSection.tsx` - Shared subsection component
- `src/components/Dialogs/settings/SettingRow.tsx` - Shared setting row component
- `src/components/Dialogs/settings/index.ts` - Barrel export

## Approach

1. Create SettingRow component for consistent layout: label, help text, control, restart indicator
2. Create SettingsSection component for subsection groupings with header
3. Map config.ts sections to categories:
   - General: general config (auto_save, auto_expand, coordinate_system, survey_file_preference, shortcut_feedback)
   - Units: units config (length_unit, angle_unit, depth_unit)
   - Display: display + section_colors config
   - Map: map config (station, shot, snap settings)
   - Validation: validation config (shot thresholds, max_shot_length, max_section_shots)
   - Export: export config (formats, precision, coordinate_format)
   - Shortcuts: Migrate existing ShortcutsTabContent from SettingsDialog.tsx - preserve table layout
   - Cache: Migrate existing cache tab - preserve stats display and clear button (data-testid="cache-stats", "clear-cache-button")
   - Advanced: debug + logging + panels configs, Reload Config button
4. Each component receives: `{ config, onChange, changedFields }` props
5. Use Toggle for boolean settings, Select for enums, number inputs with validation
6. Mark restart-required settings with small indicator badge
7. Highlight changed fields with subtle background color

## Key Context

- Config interface at `src/types/config.ts:1-379` defines all settings
- Existing General tab content at SettingsDialog.tsx handles auto_save, auto_expand, etc.
- Existing Cache tab at SettingsDialog.tsx has cache stats and clear button - PRESERVE data-testid attributes
- Existing Shortcuts tab has ShortcutsTabContent - PRESERVE table layout exactly
- Settings that require restart: logging.level, some debug options

## Acceptance
- [ ] All 9 category content components created
- [ ] SettingRow provides consistent label + help text + control layout
- [ ] SettingsSection provides subsection groupings with headers
- [ ] Toggle component used for all boolean settings
- [ ] Custom Select component used for all enum/dropdown settings
- [ ] Number inputs have min/max validation
- [ ] Changed fields highlighted with subtle background
- [ ] Restart-required settings have indicator badge
- [ ] Shortcuts table layout preserved from existing implementation
- [ ] Cache stats and clear button preserved with data-testid attributes
- [ ] Reload Config button in Advanced category
- [ ] Each component has `role="tabpanel"`, `aria-labelledby`
- [ ] pnpm tsc --noEmit passes
