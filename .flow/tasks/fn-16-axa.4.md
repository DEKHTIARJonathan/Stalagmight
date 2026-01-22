# fn-16-axa.4 Create settings category content components

## Description
Create content panel components for each of the 9 settings categories, with proper grouping, help text, and form controls. Maps to existing Config sections in `src/types/config.ts`.

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
3. **Map to existing config.ts sections** (from `src/types/config.ts`):
   - **General**: `general` config - auto_save, auto_save_interval_seconds, recent_projects_max, undo_history_limit, undo_persist_limit, shortcut_feedback
   - **Units**: `units` config - length, depth, angle, decimal_precision
   - **Display**: `display` + `section_colors` - background, grid settings, font settings, depth_gradient, palette
   - **Map**: `map` config - satellite_provider, satellite_enabled, satellite_gps_origin, zoom settings, station/shot/snap/animation configs
   - **Validation**: `validation` config - warn_shot_length_min/max, warn_depth_change_per_shot_max, warn_azimuth_deviation_max, azimuth_diff_threshold, pitch_diff_threshold
   - **Export**: `export` config - default_image_format, default_dpi, default_include_satellite/grid/labels
   - **Shortcuts**: Migrate existing ShortcutsTabContent from SettingsDialog.tsx - preserve table layout
   - **Cache**: `cache` config - tile_cache_enabled, tile_cache_max_mb, tile_ttl_days; plus cache stats display and clear button (data-testid="cache-stats", "clear-cache-button")
   - **Advanced**: `debug` + `logging` + `panels` configs, Reload Config button
4. Each component receives: `{ config, onChange, changedFields, onValidationError }` props
5. Use Toggle for boolean settings, Select for enums, number inputs with validation
6. Mark restart-required settings (logging.level) with small indicator badge
7. Highlight changed fields with subtle background color
8. Report validation errors back via `onValidationError(category, hasError)`

## Key Context

- Config interface at `src/types/config.ts:1-379` defines all settings
- Existing General tab content at SettingsDialog.tsx handles auto_save, shortcut_feedback, etc.
- Existing Cache tab at SettingsDialog.tsx has cache stats and clear button - PRESERVE data-testid attributes
- Existing Shortcuts tab has ShortcutsTabContent - PRESERVE table layout exactly
- Settings that require restart: logging.level

## Acceptance
- [ ] All 9 category content components created
- [ ] SettingRow provides consistent label + help text + control layout
- [ ] SettingsSection provides subsection groupings with headers
- [ ] Toggle component used for all boolean settings
- [ ] Custom Select component used for all enum/dropdown settings
- [ ] Number inputs have min/max validation
- [ ] Changed fields highlighted with subtle background
- [ ] Restart-required settings have indicator badge (logging.level)
- [ ] Shortcuts table layout preserved from existing implementation
- [ ] Cache stats and clear button preserved with data-testid attributes
- [ ] Reload Config button in Advanced category
- [ ] Each component has `role="tabpanel"`, `aria-labelledby`
- [ ] onValidationError callback reports errors to parent
- [ ] pnpm tsc --noEmit passes
