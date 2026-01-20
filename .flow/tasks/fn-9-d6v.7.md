# fn-9-d6v.7 Add keyboard accessibility to SectionsPanel

## Description
Add keyboard accessibility to SectionsPanel with listbox pattern.

## Files to Modify

### `src/components/SingleSystemView/SectionsPanel.tsx`

**Add ARIA attributes to container:**
```tsx
<div
  role="listbox"
  aria-label="Cave survey sections"
  tabIndex={0}
  onKeyDown={handleKeyDown}
  className="..."
>
  {sections.map((section, index) => (
    <div
      key={section.id}
      role="option"
      aria-selected={isSelected}
      tabIndex={isSelected || (index === 0 && !selection) ? 0 : -1}
      data-testid={`section-row-${section.id}`}
      onFocus={() => handleSectionMouseEnter(section.id)}
      onBlur={() => handleSectionMouseLeave()}
      // ... existing props
    >
```

**Add keyboard handler:**
```typescript
const handleKeyDown = (e: React.KeyboardEvent) => {
  const currentIndex = sections.findIndex(s => 
    (selection?.type === 'section' && selection.sectionId === s.id) ||
    hoveredSectionId === s.id
  );

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      if (currentIndex < sections.length - 1) {
        const nextSection = sections[currentIndex + 1];
        setHoveredSectionId(nextSection.id);
        // Focus the row element
        document.querySelector(`[data-testid="section-row-${nextSection.id}"]`)?.focus();
      }
      break;
    case 'ArrowUp':
      e.preventDefault();
      if (currentIndex > 0) {
        const prevSection = sections[currentIndex - 1];
        setHoveredSectionId(prevSection.id);
        document.querySelector(`[data-testid="section-row-${prevSection.id}"]`)?.focus();
      }
      break;
    case 'Enter':
    case ' ':
      e.preventDefault();
      const focusedSection = sections.find(s => hoveredSectionId === s.id);
      if (focusedSection) {
        handleSectionClick(focusedSection);
      }
      break;
    case 'Escape':
      e.preventDefault();
      clearSelection(); // Uses existing uiStore.clearSelection
      break;
  }
};
```

**Focus triggers hover highlight (per interview):**
`onFocus` calls the same `setHoveredSectionId` as mouse hover, so keyboard focus shows map highlight.

## Accessibility Pattern
- Listbox pattern: container has `role="listbox"`, items have `role="option"`
- DOM focus movement: focus actually moves between options (not aria-activedescendant)
- Arrow keys navigate, Enter/Space select, Escape clears
- Focus on row triggers map highlight (same as mouse hover)
## Acceptance
- [ ] Container has `role="listbox"` and `aria-label`
- [ ] Container has `tabIndex={0}` and `onKeyDown` handler
- [ ] Section rows have `role="option"` and `aria-selected`
- [ ] Section rows have roving `tabIndex` (0 for current, -1 for others)
- [ ] Arrow down moves focus to next row and sets hoveredSectionId
- [ ] Arrow up moves focus to previous row and sets hoveredSectionId
- [ ] Enter/Space selects the focused section
- [ ] Escape calls clearSelection() from uiStore
- [ ] Focus on row triggers map highlight via setHoveredSectionId
- [ ] Blur on row clears hoveredSectionId
- [ ] First row focusable when nothing selected
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
