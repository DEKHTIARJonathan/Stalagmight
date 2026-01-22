# fn-16-axa.2 Create custom styled Select/Dropdown component

## Description
Enhance the existing Select component to have custom styling matching the app's dark theme, instead of relying on native browser select appearance. Must maintain full accessibility.

**Size:** M
**Files:**
- `src/components/common/Select.tsx` - Enhance existing component

## Approach

1. Read current Select.tsx implementation at `src/components/common/Select.tsx`
2. Convert from native select to custom listbox pattern with proper ARIA
3. Use `role="listbox"` for options container, `role="option"` for items
4. Implement keyboard navigation: Arrow Up/Down to navigate, Enter to select, Escape to close
5. Click-outside-to-close using existing pattern from DisplayMenu.tsx
6. Scroll active option into view when navigating with keyboard
7. Style with Tailwind dark theme colors (panel=#16213e, border=#0f3460)
8. Support grouped options (SelectOptionGroup) with visual separators

## Key Context

- Existing Select.tsx at `src/components/common/Select.tsx` uses native HTML select
- DisplayMenu.tsx has dropdown pattern at `src/components/SingleSystemView/DisplayMenu.tsx:36-213`
- SectionsPanel has listbox keyboard navigation pattern at `src/components/SidePanel/SectionsPanel.tsx`
- Practice scout warns: Safari has specific bugs with custom selects - test thoroughly
- Must preserve existing SelectProps interface for backwards compatibility

## Acceptance
- [ ] Dropdown trigger shows selected value with arrow indicator
- [ ] Options list appears below trigger on click
- [ ] Arrow Up/Down navigates options with visual highlight
- [ ] Enter selects highlighted option and closes
- [ ] Escape closes without selecting
- [ ] Click outside closes dropdown
- [ ] Active option scrolls into view during keyboard navigation
- [ ] Grouped options display with section headers
- [ ] `role="listbox"`, `role="option"` with `aria-selected`
- [ ] `aria-expanded` on trigger reflects open state
- [ ] Existing SelectProps interface preserved (backwards compatible)
- [ ] pnpm tsc --noEmit passes
