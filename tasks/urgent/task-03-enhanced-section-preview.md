# Task 03: Enhance SectionPreview with Pan/Zoom/Click

## Description

Enhance the existing SectionPreview component to support pan, zoom, and click-to-select-station functionality. The preview should show section outline with station dots.

## Files to Modify

- `src/components/Dialogs/SectionPreview.tsx`

## Implementation

### 1. Current State

SectionPreview currently renders a static SVG of the section. It needs to be enhanced with:
- Mouse drag to pan
- Scroll wheel to zoom
- Click on station dot to select (callback)

### 2. Add Pan/Zoom State

```tsx
const [viewBox, setViewBox] = useState({ x: 0, y: 0, width: 250, height: 250 });
const [isDragging, setIsDragging] = useState(false);
const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
```

### 3. Pan Implementation

- On mousedown: set isDragging=true, record start position
- On mousemove (while dragging): update viewBox x/y based on delta
- On mouseup: set isDragging=false

### 4. Zoom Implementation

- On wheel: adjust viewBox width/height (scale factor)
- Zoom centered on mouse position
- Min/max zoom limits (0.25x to 4x)

### 5. Click-to-Select

- Station dots are clickable circles
- onClick callback: `onStationClick?: (stationIndex: number) => void`
- Hover effect on stations (cursor: pointer, highlight)

### 6. Props Changes

```tsx
interface SectionPreviewProps {
  section: DmpSection | null;
  existingStation?: Station | null;
  importStationIndex?: 'first' | 'last' | null;
  // New props:
  onStationClick?: (stationIndex: number) => void;
  selectedStationIndex?: number | null;
  size?: number; // default 250
}
```

### 7. Visual Updates

- Larger preview: 250x250px (from requirements)
- Selected station has highlighted ring
- Cursor changes on hover over stations
- No visible zoom/pan controls (mouse-only per requirements)

## Acceptance Criteria

- [ ] Pan works via mouse drag
- [ ] Zoom works via scroll wheel
- [ ] Click on station triggers callback
- [ ] Selected station shows highlight
- [ ] Cursor changes to pointer on station hover
- [ ] Size prop controls preview dimensions
- [ ] No visible pan/zoom buttons (mouse only)
- [ ] TypeScript compiles without errors
- [ ] Existing tests pass

## Existing Tests to Modify

The following existing test files must be updated to account for changes made in this task:

### Playwright Tests
- `e2e-playwright/import-dialog.spec.ts` - Section preview tests need updating for new pan/zoom/click behavior

### WebdriverIO Tests
- `e2e/specs/import-dmp-dialog.spec.ts` - Preview interaction tests may need updating

### Mock Updates
- `e2e-playwright/mocks/tauri-ipc.ts` - No changes needed

## Test Suggestions

### Unit Tests (Rust)
N/A - Frontend-only task.

### Playwright Tests (3-10)
1. Test section preview renders with correct size
2. Test clicking on station fires onStationClick callback
3. Test selected station shows highlight ring
4. Test cursor changes to pointer on station hover
5. Test scroll wheel changes zoom level
6. Test drag pans the view
7. Test preview resets to fit when section changes

### WebdriverIO Tests (3-10)
1. Test section preview displays in DmpImportDialog
2. Test station selection updates table highlight
3. Test pan and zoom interaction with full app

## Done Summary
(To be filled when complete)

## Evidence
- Commits:
- Tests:
- PRs:
