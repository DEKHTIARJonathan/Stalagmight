# Settings Dialog Restructure with Left Sidebar Navigation

## Problem
The current Settings dialog uses horizontal tabs at the top (General, Cache, Shortcuts), which doesn't scale well as more settings are added and doesn't match modern desktop application patterns. Users expect a more organized, Adobe Photoshop Preferences-style layout with a left sidebar for navigation.

## Key Decisions

### Layout & Structure
- **Sidebar position**: Fixed width (~150px) on the left side
- **Sidebar content**: Text-only category labels (no icons)
- **Divider**: Thin border line between sidebar and content area
- **Dialog size**: Fixed size, minimum 600px width × 500px height
- **Content area**: Independent scrolling, sidebar stays fixed
- **Dialog title**: Static "Settings" (doesn't change per category)

### Categories (9 total)
1. **General** - Auto-save, auto-expand sections, coordinate system, survey file preference
2. **Units** - Length units, angle units, grouped by type with subsection headers
3. **Display** - Visual settings, section colors (predefined palette)
4. **Map** - Station map and station point settings combined
5. **Validation** - Shot validation thresholds and length limits
6. **Export** - Export formats, precision, units preferences
7. **Shortcuts** - Keep current table layout for key binding editor
8. **Cache** - Cache settings, clear button, show cache statistics (size, item count)
9. **Advanced** - Debug settings, logging, panel positions, internal state, Reload Config button (separated visually with divider above)

### Navigation & Selection
- **Selection style**: Background highlight with existing accent color
- **Hover effect**: Subtle hover state
- **Error indicator**: Red dot next to category name when validation issues exist
- **Keyboard navigation**: Full support (arrow keys to navigate, Enter to select)
- **Remember tab**: No - always open to General category
- **Sidebar collapsible**: No - always visible at fixed width

### Content Area
- **Category header**: Display category title as header in content area
- **Subsection headers**: Group related settings with subtle headers within categories
- **Help text**: Inline description below each setting explaining what it does
- **Restart indicator**: Mark settings that require app restart with small label/icon
- **Change indicator**: Highlight changed fields before saving

### Controls
- **Toggle settings**: iOS-style switch/toggle components
- **Dropdowns**: Custom styled dropdowns matching app visual style
- **Number inputs**: Text input with validation (min/max)
- **Color settings**: Predefined palette (keep current behavior)

### Actions & Buttons
- **Footer position**: Bottom of dialog, full-width
- **Save button**: Disabled when no changes, enabled when modified
- **Cancel button**: Always enabled
- **Reset to Defaults**: Per-category, button in category header area, requires confirmation dialog

### Behavior
- **Unsaved changes**: Preserve when switching categories (don't discard)
- **Close with X**: Show confirmation dialog ("Discard unsaved changes?") with Save/Discard/Cancel
- **Click outside**: Does not close dialog (require explicit close)
- **Transitions**: No animation when switching categories (instant)
- **Search**: No search functionality (categories are clear enough)
- **Import/Export**: No (settings file can be copied manually)

### Keyboard Shortcut
- **Open Settings**: Cmd/Ctrl+, (standard app settings shortcut)

### Accessibility
- Full ARIA support with proper roles, labels, and keyboard navigation

### Preserve from Current Implementation
- Shortcuts table layout (current key binding editor)
- Cache clear functionality and behavior
- Input validation behavior

## Edge Cases
- Long setting values should truncate with ellipsis
- Content area scrolls if settings exceed visible area
- Error states in shortcuts (conflicts) show red dot on Shortcuts category

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
- [ ] Toggle switches for boolean settings
- [ ] Custom styled dropdowns
- [ ] Reset to Defaults button in category header with confirmation
- [ ] Restart-required indicator on applicable settings
- [ ] Changed fields highlighted before saving
- [ ] Save button disabled when no changes
- [ ] Unsaved changes preserved when switching categories
- [ ] Confirmation dialog when closing with unsaved changes
- [ ] Dialog has minimum size 600px × 500px
- [ ] Cmd/Ctrl+, keyboard shortcut opens Settings
- [ ] Cache category shows statistics (size, item count)
- [ ] Advanced category visually separated with divider
- [ ] Shortcuts table layout preserved
- [ ] Full ARIA accessibility support
- [ ] pnpm tsc --noEmit passes
- [ ] pnpm test:ui passes
