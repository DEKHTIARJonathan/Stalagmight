# fn-16-axa.2 Upgrade custom Select component with ARIA listbox and keyboard navigation

## Description
Enhance the existing custom Select component to add full ARIA listbox roles and keyboard navigation. The component is already a custom dropdown (NOT native select), but needs accessibility improvements.

**Size:** M
**Files:**
- `src/components/common/Select.tsx` - Enhance existing custom component

## Approach

1. Read current Select.tsx implementation at `src/components/common/Select.tsx`
2. **Note: It's already custom** - task is to ADD ARIA listbox roles, not convert from native
3. Add ARIA roles:
   - Trigger button: `role="combobox"`, `aria-expanded`, `aria-haspopup="listbox"`, `aria-controls`
   - Options container: `role="listbox"`, unique `id` for aria-controls
   - Each option: `role="option"`, `aria-selected`, unique `id` for aria-activedescendant
4. Implement `aria-activedescendant` pattern:
   - Focus stays on trigger button
   - `aria-activedescendant` points to currently highlighted option's id
   - Arrow keys update highlighted option (not focus)
5. Keyboard navigation:
   - Arrow Up/Down: Navigate options with visual highlight
   - Enter: Select highlighted option and close
   - Escape: Close without selecting
   - Home/End: Jump to first/last option
6. Scroll highlighted option into view during keyboard navigation
7. Preserve existing `data-dropdown-open` attribute behavior
8. Keep backwards compatibility with existing SelectProps interface

## Key Context

- **Current Select.tsx is already custom** (not native HTML select) - review confirms this
- DisplayMenu.tsx has dropdown pattern at `src/components/SingleSystemView/DisplayMenu.tsx:36-213`
- SectionsPanel has keyboard navigation pattern at `src/components/SingleSystemView/SectionsPanel.tsx` (correct path)
- Practice scout warns: Safari has specific bugs with custom selects - test thoroughly
- Use `useId()` hook for generating unique IDs for ARIA attributes

## Acceptance
- [ ] Trigger has `role="combobox"`, `aria-expanded`, `aria-haspopup="listbox"`, `aria-controls`
- [ ] Options container has `role="listbox"` with unique id
- [ ] Each option has `role="option"`, `aria-selected`, unique id
- [ ] `aria-activedescendant` on trigger points to highlighted option
- [ ] Arrow Up/Down navigates options with visual highlight
- [ ] Enter selects highlighted option and closes
- [ ] Escape closes without selecting
- [ ] Home/End jump to first/last option
- [ ] Active option scrolls into view during keyboard navigation
- [ ] Grouped options display with section headers
- [ ] Existing SelectProps interface preserved (backwards compatible)
- [ ] `data-dropdown-open` attribute behavior preserved
- [ ] pnpm tsc --noEmit passes
