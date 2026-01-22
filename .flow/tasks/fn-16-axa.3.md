# fn-16-axa.3 Create SettingsSidebar component with keyboard navigation

## Description
Create the left sidebar navigation component for the Settings dialog with category items, keyboard navigation, error indicators, and proper ARIA tab pattern.

**Size:** M
**Files:**
- `src/components/Dialogs/SettingsSidebar.tsx` - New component

## Approach

1. Follow SectionsPanel.tsx pattern at `src/components/SidePanel/SectionsPanel.tsx` for listbox keyboard navigation
2. Use ARIA tab pattern: `role="tablist"` with `aria-orientation="vertical"`, `role="tab"` for items
3. Implement roving tabindex: active tab has `tabindex="0"`, others have `tabindex="-1"`
4. Keyboard navigation: Arrow Up/Down moves between tabs, Home/End for first/last
5. Categories (9 total): General, Units, Display, Map, Validation, Export, Shortcuts, Cache, Advanced
6. Visual styles from spec:
   - Fixed width ~150px
   - Background highlight with accent color for selected
   - Subtle hover state
   - Red dot indicator for categories with errors
   - Thin border divider on right edge
   - Advanced category has visual separator above it
7. Props: `{ activeCategory, onCategoryChange, categoryErrors: Record<string, boolean> }`

## Key Context

- SectionsPanel.tsx has keyboard navigation pattern with Home/End/Arrow keys
- Tab ARIA pattern requires Arrow keys (not Tab key) between items - WAI-ARIA spec
- Tailwind colors: accent=#4ecdc4, error=#ff6b6b, border=#0f3460
- Category type: `'general' | 'units' | 'display' | 'map' | 'validation' | 'export' | 'shortcuts' | 'cache' | 'advanced'`

## Acceptance
- [ ] Renders 9 category items as vertical list
- [ ] Fixed width ~150px with border-right divider
- [ ] Selected category has background highlight with accent color
- [ ] Hover state on non-selected items
- [ ] Red dot (error badge) shows next to categories with errors
- [ ] Visual separator line above Advanced category
- [ ] `role="tablist"` with `aria-orientation="vertical"`
- [ ] Each item has `role="tab"`, `aria-selected`, `aria-controls`
- [ ] Arrow Up/Down navigates between categories
- [ ] Home/End jump to first/last category
- [ ] Enter activates the focused category
- [ ] Roving tabindex pattern (only active tab in tab order)
- [ ] pnpm tsc --noEmit passes
