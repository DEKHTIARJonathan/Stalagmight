# fn-51-ctu.3 Enhance SectionPreview with Pan/Zoom/Click

## Description
Enhance the existing SectionPreview component to support pan, zoom, and click-to-select-station functionality.

## Files to Modify
- `src/components/Dialogs/SectionPreview.tsx`

## Features to Add
- Mouse drag to pan
- Scroll wheel to zoom (0.25x to 4x limits, centered on mouse)
- Click on station dot to select (callback)
- Selected station shows highlighted ring
- No visible zoom/pan controls (mouse only)

## Props Changes
```tsx
interface SectionPreviewProps {
  section: DmpSection | null;
  existingStation?: Station | null;
  importStationIndex?: 'first' | 'last' | null;
  onStationClick?: (stationIndex: number) => void;  // NEW
  selectedStationIndex?: number | null;  // NEW
  size?: number;  // default 250
}
```

## Existing Tests to Modify
- `e2e-playwright/import-dialog.spec.ts`
- `e2e/specs/import-dmp-dialog.spec.ts`

## References
- `tasks/urgent/task-03-enhanced-section-preview.md`
- `src/components/Dialogs/SectionPreview.tsx:1-396`
## Acceptance
- [ ] Pan works via mouse drag
- [ ] Zoom works via scroll wheel
- [ ] Click on station triggers callback
- [ ] Selected station shows highlight
- [ ] Cursor changes to pointer on station hover
- [ ] Size prop controls preview dimensions
- [ ] No visible pan/zoom buttons (mouse only)
- [ ] TypeScript compiles without errors
- [ ] Existing tests pass
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
