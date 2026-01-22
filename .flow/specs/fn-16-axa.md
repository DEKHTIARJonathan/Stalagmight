# Settings Dialog Restructure with Left Sidebar Navigation

## Problem
The current Settings dialog uses horizontal tabs at the top (General, Cache, Shortcuts), which doesn't scale well as more settings are added and doesn't match modern desktop application patterns. Users expect a more organized, Adobe Photoshop Preferences-style layout with a left sidebar for navigation.

## Key Decisions

### Layout & Structure
- **Sidebar position**: Fixed width (~150px) on the left side
- **Sidebar content**: Text-only category labels (no icons)
- **Divider**: Thin border line between sidebar and content area
- **Dialog size**: Fixed size, minimum 600px width × 500px height
- **Content area**: Independent scrolling (via flex layout with overflow-hidden on wrapper, overflow-auto on content pane)
- **Dialog title**: Static "Settings" (doesn't change per category)
- **Backdrop click**: Does NOT close dialog (requires explicit close via X or Cancel)

### Categories (9 total)
Categories map to existing Config sections in `src/types/config.ts`:
1. **General** - `general` config: auto_save, auto_save_interval_seconds, recent_projects_max, undo_history_limit, undo_persist_limit, shortcut_feedback
2. **Units** - `units` config: length, depth, angle, decimal_precision
3. **Display** - `display` + `section_colors` config: background, grid, font, depth_gradient settings, color palette
4. **Map** - `map` config: satellite_provider, satellite_enabled, satellite_gps_origin, zoom settings, station, shot, snap, animation configs
5. **Validation** - `validation` config: warn_shot_length_min/max, warn_depth_change_per_shot_max, warn_azimuth_deviation_max, azimuth_diff_threshold, pitch_diff_threshold
6. **Export** - `export` config: default_image_format, default_dpi, default_include_satellite/grid/labels
7. **Shortcuts** - Keep current ShortcutsTabContent table layout
8. **Cache** - `cache` config: tile_cache_enabled, tile_cache_max_mb, tile_ttl_days, plus cache stats display and clear button
9. **Advanced** - `debug` + `logging` + `panels` configs, Reload Config button (separated visually with divider above)

### Navigation & Selection
- **Selection style**: Background highlight with existing accent color
- **Hover effect**: Subtle hover state
- **Error indicator**: Red dot next to category name when validation issues exist
- **Keyboard navigation**: Full support
  - Arrow Up/Down: Move focus between categories (roving tabindex)
  - Enter: Activate focused category (manual activation pattern)
  - Track `focusedCategory` (roving tabindex=0) separately from `activeCategory` (aria-selected=true)
- **Remember tab**: No - always open to General category
- **Sidebar collapsible**: No - always visible at fixed width

### Content Area
- **Category header**: Display category title as header in content area
- **Subsection headers**: Group related settings with subtle headers within categories
- **Help text**: Inline description below each setting explaining what it does
- **Restart indicator**: Mark settings that require app restart with small label/icon (logging.level)
- **Change indicator**: Highlight changed fields with subtle background color

### Controls
- **Toggle settings**: Non-button focusable element (`div tabIndex=0 role="switch"`), Space toggles, Enter does NOT toggle
- **Dropdowns**: Enhance existing custom Select with ARIA listbox roles and keyboard navigation
- **Number inputs**: Text input with validation (min/max)
- **Color settings**: Predefined palette (keep current behavior)

### Actions & Buttons
- **Footer position**: Bottom of dialog, full-width
- **Save button**: Disabled when no changes, enabled when modified
- **Cancel button**: Always enabled
- **Reset to Defaults**: Per-category, button in category header area, requires confirmation dialog

### Behavior
- **Unsaved changes**: Preserve when switching categories (don't discard)
- **Close with X**: Show custom confirmation dialog with Save/Discard/Cancel options (DialogWrapper's built-in only has Cancel/Discard)
- **Backdrop click**: Does NOT close dialog (add `closeOnBackdropClick={false}` prop to DialogWrapper or Settings-specific wrapper)
- **Transitions**: No animation when switching categories (instant)
- **Search**: No search functionality (categories are clear enough)
- **Import/Export**: No (settings file can be copied manually)

### Keyboard Shortcut
- **Open Settings**: Cmd/Ctrl+, (standard app settings shortcut)
- **Key detection**: Use `event.key === ','` with Ctrl/Meta modifier
- **Reserved shortcuts file**: `src/utils/shortcuts.ts` (not src/types/shortcuts.ts)
- **Input guard behavior**: Allow Ctrl/Cmd+, even in input fields (handle before input guard in useKeyboardShortcuts)

### Validation & Error State
- **categoryErrors**: `Record<Category, boolean>` computed from localConfig + validation state
- **Shortcuts validation**: Validate entire binding set on load (detect pre-existing conflicts)
- **Error flow**: Field components report errors up to SettingsDialog, which computes categoryErrors and passes to sidebar

### Accessibility
- Full ARIA support with proper roles, labels, and keyboard navigation
- Tab pattern with manual activation (focus vs selection separation)
- Custom Select: upgrade to ARIA listbox with `role="listbox"`, `role="option"`, `aria-activedescendant`

### Preserve from Current Implementation
- Shortcuts table layout (current key binding editor)
- Cache clear functionality and behavior
- Input validation behavior

## Edge Cases
- Long setting values should truncate with ellipsis
- Content area scrolls if settings exceed visible area
- Error states in shortcuts (conflicts) show red dot on Shortcuts category
- Dialog cannot be closed by clicking outside (explicit close required)

## Open Questions
- None - all decisions captured during interview

## Acceptance
- [ ] Dialog opens with left sidebar navigation layout
- [ ] 9 categories displayed in sidebar with text labels
- [ ] Fixed sidebar width ~150px, content area scrolls independently
- [ ] Background highlight on selected category with accent color
- [ ] Hover states on category items
- [ ] Red dot indicator on categories with validation errors
- [ ] Full keyboard navigation (arrows + Enter + Escape)
- [ ] Category title displayed as header in content area
- [ ] Settings grouped with subsection headers within categories
- [ ] Inline help text descriptions under settings
- [ ] Toggle switches for boolean settings (Space toggles, Enter does not)
- [ ] Custom styled dropdowns with ARIA listbox
- [ ] Reset to Defaults button in category header with confirmation
- [ ] Restart-required indicator on applicable settings
- [ ] Changed fields highlighted before saving
- [ ] Save button disabled when no changes
- [ ] Unsaved changes preserved when switching categories
- [ ] Custom confirmation dialog when closing with unsaved changes (Save/Discard/Cancel)
- [ ] Backdrop click does NOT close dialog
- [ ] Dialog has minimum size 600px × 500px
- [ ] Cmd/Ctrl+, keyboard shortcut opens Settings (works even in input fields)
- [ ] Cache category shows statistics (size, item count)
- [ ] Advanced category visually separated with divider
- [ ] Shortcuts table layout preserved
- [ ] Full ARIA accessibility support
- [ ] pnpm tsc --noEmit passes
- [ ] pnpm test:ui passes
