# fn-16-axa.3 Create SettingsSidebar component with keyboard navigation

## Description
Create the left sidebar navigation component for the Settings dialog with category items, keyboard navigation, error indicators, and proper ARIA tab pattern with manual activation.

**Size:** M
**Files:**
- `src/components/Dialogs/SettingsSidebar.tsx` - New component

## Approach

1. Follow SectionsPanel.tsx pattern at `src/components/SingleSystemView/SectionsPanel.tsx` for listbox keyboard navigation
2. Use ARIA tab pattern: `role="tablist"` with `aria-orientation="vertical"`, `role="tab"` for items
3. **Manual activation pattern** (focus vs selection separation):
   - Track `focusedIndex` (which tab has `tabindex="0"`)
   - Track `activeCategory` (which tab has `aria-selected="true"`)
   - Arrow keys change `focusedIndex` only
   - Enter key sets `activeCategory` to current `focusedIndex`
4. Roving tabindex: focused tab has `tabindex="0"`, others have `tabindex="-1"`
5. Keyboard navigation:
   - Arrow Up/Down: Move focus between tabs (update focusedIndex)
   - Home/End: Jump to first/last tab
   - Enter: Activate focused tab (update activeCategory)
6. Categories (9 total): General, Units, Display, Map, Validation, Export, Shortcuts, Cache, Advanced
7. Visual styles from spec:
   - Fixed width ~150px
   - Background highlight with accent color for selected (activeCategory)
   - Subtle hover state
   - Focus ring on focused item (focusedIndex)
   - Red dot indicator for categories with errors
   - Thin border divider on right edge
   - Advanced category has visual separator above it
8. Props: `{ activeCategory, onCategoryChange, focusedIndex, onFocusChange, categoryErrors: Record<string, boolean> }`
9. Use `aria-controls` with stable panel ids (use `useId()` hook)

## Key Context

- SectionsPanel.tsx at `src/components/SingleSystemView/SectionsPanel.tsx` has keyboard navigation pattern with Home/End/Arrow keys
- Tab ARIA pattern requires Arrow keys (not Tab key) between items - WAI-ARIA spec
- **Manual activation**: Arrow keys move focus, Enter activates (not auto-activate on focus)
- Tailwind colors: accent=#4ecdc4, error=#ff6b6b, border=#0f3460
- Category type: `'general' | 'units' | 'display' | 'map' | 'validation' | 'export' | 'shortcuts' | 'cache' | 'advanced'`

## Acceptance
- [ ] Renders 9 category items as vertical list
- [ ] Fixed width ~150px with border-right divider
- [ ] Selected category (activeCategory) has background highlight with accent color
- [ ] Focused category (focusedIndex) has visible focus ring
- [ ] Hover state on non-selected items
- [ ] Red dot (error badge) shows next to categories with errors
- [ ] Visual separator line above Advanced category
- [ ] `role="tablist"` with `aria-orientation="vertical"`
- [ ] Each item has `role="tab"`, `aria-selected`, `aria-controls`
- [ ] Arrow Up/Down moves focus (focusedIndex) between categories
- [ ] Home/End jump to first/last category
- [ ] **Enter activates the focused category** (sets activeCategory)
- [ ] Roving tabindex pattern (only focused tab has tabindex=0)
- [ ] `data-testid` attributes on sidebar items for E2E testing
- [ ] pnpm tsc --noEmit passes
