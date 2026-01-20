# fn-9-d6v.6 Add mouse hover handlers to SectionsPanel

## Description
Add mouse hover handlers to SectionsPanel for panel-to-map hover highlighting.

## Files to Modify

### `src/components/SingleSystemView/SectionsPanel.tsx`

**Add store import:**
```typescript
const { selection, setSelection, hoveredSectionId, setHoveredSectionId, openDialog } = useUIStore();
```

**Add hover handlers:**
```typescript
const handleSectionMouseEnter = (sectionId: SectionId) => {
  setHoveredSectionId(sectionId);
};

const handleSectionMouseLeave = () => {
  setHoveredSectionId(null);
};
```

**Update section row element (around L69-107):**
```tsx
<div
  key={section.id}
  data-testid={`section-row-${section.id}`}
  className={cn(
    'group flex items-center gap-2 px-2 py-1.5 cursor-pointer rounded-md transition-colors',
    // Highlight when: selected OR hovered from panel OR hovered from map
    (isSelected || hoveredSectionId === section.id) && 'bg-accent/20'
  )}
  onClick={() => handleSectionClick(section)}
  onMouseEnter={() => handleSectionMouseEnter(section.id)}
  onMouseLeave={handleSectionMouseLeave}
>
  {/* existing content */}
</div>
```

## Styling Notes
- Use same `bg-accent/20` for both selection and hover (per interview decision)
- Hover appearance overrides selection (both use same styling, so visual is same)
- Panel row highlights when:
  1. Row is selected (clicked)
  2. Row is hovered with mouse
  3. Section's features are hovered on map (bidirectional via `hoveredSectionId`)
## Acceptance
- [ ] `hoveredSectionId` extracted from useUIStore
- [ ] `setHoveredSectionId` extracted from useUIStore  
- [ ] `handleSectionMouseEnter` sets hoveredSectionId to section.id
- [ ] `handleSectionMouseLeave` sets hoveredSectionId to null
- [ ] Section row has `onMouseEnter` and `onMouseLeave` handlers
- [ ] Section row has `data-testid="section-row-{id}"` attribute
- [ ] Row background highlights on hover OR selection OR map-derived hover
- [ ] Same visual treatment (`bg-accent/20`) for all highlight states
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
