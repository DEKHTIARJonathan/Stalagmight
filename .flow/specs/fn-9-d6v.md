# Section Hover/Selection Highlighting on Map

## Problem
When users hover or select a section in the Sections panel, nothing happens on the map. Users expect to see all shots and stations belonging to that section highlighted on the map, similar to how individual shots/stations highlight when hovered on the map.

Additionally, the interaction should be bidirectional: hovering shots/stations on the map should highlight the corresponding section row in the Sections panel.

## Approach

### State Management (uiStore)
Add `hoveredSectionId: SectionId | null` to uiStore with `setHoveredSectionId` action at lines 183-186 (alongside existing `hoveredStation`, `hoveredShot`).

**Key files:**
- `src/store/uiStore.ts:183-186` - existing hover state pattern
- `src/store/uiStore.ts:450-453` - hover setter implementation

### SurveyLayer API
Add methods following existing patterns at lines 583-598:
- `setHoveredSection(sectionId: SectionId | null)`
- `setSelectedSection(sectionId: SectionId | null)`

**CRITICAL: String Storage and Conversion**
SurveyLayer stores `hoveredSectionId` and `selectedSectionId` as **strings** (new private fields).

**Conversion flow:**
1. **Setters convert number to string:** `this.hoveredSectionId = sectionId !== null ? String(sectionId) : null`
2. **Expressions compare strings:** `['==', ['to-string', ['get', 'sectionId']], this.hoveredSectionId ?? '']`
3. **Both sides are strings:** Feature sectionId (number) is converted via `to-string`, stored ID is already string

**Key files:**
- `src/components/Map/SurveyLayer.tsx:56-61` - visual state tracking (add two new fields)
- `src/components/Map/SurveyLayer.tsx:583-598` - setter methods pattern

### MapLibre Expression Builder
Create `src/utils/maplibre-expressions.ts` with pure functions for building priority-based case expressions.

**Justification for utility:**
1. Current inline expressions (L535-578) are hard to read and duplicate logic
2. Utility enables unit testing of expression building (pure function: input → output)
3. Centralizes the sectionId number→string conversion pattern
4. Reduces risk of expression typos that cause silent failures

**Type imports (type-only to avoid runtime dependency):**
```typescript
import type { ExpressionSpecification } from 'maplibre-gl';
```

**Test approach:** Tests assert on plain array structure (e.g., `['case', ['==', ...], value, fallback]`). No MapLibre runtime needed - expressions are just nested arrays.

### updateVisualState() Changes - EXPLICIT EXPRESSIONS

**Station stroke-width (L538-547):**
```typescript
this.map.setPaintProperty(this.stationsLayerId, 'circle-stroke-width', [
  'case',
  ['==', stationIdExpr, this.snappedStationId ?? ''], 4,        // Snap
  ['==', stationIdExpr, this.hoveredStationId ?? ''], 3,        // Individual hover
  ['==', ['to-string', ['get', 'sectionId']], this.hoveredSectionId ?? ''], 3,  // SECTION HOVER
  ['==', stationIdExpr, this.selectedStationId ?? ''], 2,       // Individual selected
  ['==', ['to-string', ['get', 'sectionId']], this.selectedSectionId ?? ''], 2, // SECTION SELECTED
  1,  // Normal
]);
```

**Station stroke-color (L550-559):**
```typescript
this.map.setPaintProperty(this.stationsLayerId, 'circle-stroke-color', [
  'case',
  ['==', stationIdExpr, this.snappedStationId ?? ''], '#00ffcc',  // Snap cyan
  ['==', stationIdExpr, this.selectedStationId ?? ''], '#00aaff', // Individual selected
  ['==', ['to-string', ['get', 'sectionId']], this.selectedSectionId ?? ''], '#00aaff', // SECTION SELECTED
  ['==', stationIdExpr, this.hoveredStationId ?? ''], '#0066ff',  // Individual hover
  ['==', ['to-string', ['get', 'sectionId']], this.hoveredSectionId ?? ''], '#0066ff',  // SECTION HOVER
  '#000000',  // Normal (black stroke)
]);
```

**Shot line-width (L572-579):**
```typescript
this.map.setPaintProperty(this.shotsLayerId, 'line-width', [
  'case',
  ['==', shotIdExpr, this.hoveredShotId ?? ''], 4,               // Individual hover
  ['==', ['to-string', ['get', 'sectionId']], this.hoveredSectionId ?? ''], 4,  // SECTION HOVER
  ['==', shotIdExpr, this.selectedShotId ?? ''], 3,              // Individual selected
  ['==', ['to-string', ['get', 'sectionId']], this.selectedSectionId ?? ''], 3, // SECTION SELECTED
  2,  // Normal
]);
```

**Note on zero-datum stations:** Zero-datum stations have gold **fill** (circle-color, L264) and larger radius (L257-260), but standard black stroke. Section hover/selection will change the stroke color to blue, which is intentional - the gold fill remains visible.

### Visual Priority Order (highest to lowest)
1. Snap (4px stroke, #00ffcc)
2. Individual hover (3px stroke, #0066ff)
3. **Section hover (3px stroke, #0066ff)** - NEW
4. Individual selected (2px stroke, #00aaff)
5. **Section selected (2px stroke, #00aaff)** - NEW
6. Normal (1px stroke, #000000)

### Sections Panel Keyboard Navigation
**Concrete implementation using roving tabindex:**

```tsx
// Track focus at panel level
const [focusedIndex, setFocusedIndex] = useState<number>(-1);

// Container handles blur - clears hover when focus leaves panel entirely
<div
  role="listbox"
  aria-label="Cave survey sections"
  onBlur={(e) => {
    // Only clear if focus is leaving the listbox container entirely
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setFocusedIndex(-1);
      setHoveredSectionId(null);
    }
  }}
>
  {sections.map((section, index) => (
    <div
      role="option"
      tabIndex={focusedIndex === index ? 0 : (focusedIndex === -1 && index === 0 ? 0 : -1)}
      aria-selected={isSelected}
      onFocus={() => {
        setFocusedIndex(index);
        setHoveredSectionId(section.id);  // Map highlight on focus
      }}
      // NO per-row onBlur - handled at container level
      onKeyDown={(e) => handleKeyDown(e, index)}
    />
  ))}
</div>
```

**Keyboard handler - ALL keys use preventDefault + stopPropagation:**
```typescript
const handleKeyDown = (e: React.KeyboardEvent) => {
  switch (e.key) {
    case 'ArrowDown':
    case 'ArrowUp':
    case 'Home':
    case 'End':
    case 'Enter':
    case ' ':  // Space
    case 'Escape':
      e.preventDefault();     // Prevent scroll/default behavior
      e.stopPropagation();    // Prevent global keyboard shortcuts
      // ... handle key
      break;
  }
};
```

### MapCanvas Integration
**Key file:** `src/components/Map/MapCanvas.tsx:584-597` - selection sync pattern

Extend existing selection sync effect to handle section type.
Add new effect for hover sync from uiStore to SurveyLayer.

### Bidirectional Sync (Map → Panel)
Derive `hoveredSectionId` from existing hover callbacks in `useMapTools`:
- `handleStationHover(ref)`: Set `hoveredSectionId` to `ref.section_id` (or `null` if `ref` is null)
- `handleShotHover(shot)`: Set `hoveredSectionId` to `shot.sectionId` (or `null` if `shot` is null)

**Clear behavior:** When `handleStationHover(null)` or `handleShotHover(null)` is called (mouse leaves feature), `setHoveredSectionId(null)` is called to clear the panel highlight.

## Edge Cases
- Empty sections (no shots): Still interactive, just no map highlight
- Virtual shots: Include in highlight (same visual treatment as real shots)
- Merged stations: Only highlight stations belonging to hovered section, not merge partners
- Loop closures: Don't highlight with section hover (separate visualization)
- Merge connection lines: No change on section hover
- Hover overrides selection: When different section is hovered while one is selected, hover visuals take precedence
- Same section hovered+selected: Hover appearance (consistent with priority rule)
- Zero-datum stations: Gold **fill** preserved (expression only changes stroke color)
- Rapid hover transitions: No debounce needed - React/MapLibre handle updates efficiently

## File References
| File | Lines | Purpose |
|------|-------|---------|
| `src/store/uiStore.ts` | 183-186, 450-453 | Hover state pattern |
| `src/components/Map/SurveyLayer.tsx` | 56-61, 532-580, 583-598 | Visual state, expressions, setters |
| `src/components/Map/MapCanvas.tsx` | 584-597, 599-603 | Selection/hover sync effects |
| `src/components/SingleSystemView/SectionsPanel.tsx` | 68-108 | Section list rendering |
| `src/hooks/useMapTools.ts` | 299-312 | Hover callback pattern |

## Quick commands
```bash
# Type check
pnpm tsc --noEmit

# Run unit tests (includes expression builder tests)
pnpm test

# Run Playwright E2E tests
pnpm test:ui

# Run Rust tests
cargo test --manifest-path src-tauri/Cargo.toml
```

## Acceptance
- [ ] Hovering section row in panel highlights all shots/stations on map (simultaneous)
- [ ] Clicking section row in panel selects and highlights all shots/stations on map
- [ ] Hovering shot/station on map highlights corresponding section row in panel
- [ ] Keyboard navigation works: Tab into panel, arrow keys between rows, Enter to select
- [ ] Focus on row triggers map highlight (same as mouse hover)
- [ ] Escape clears selection
- [ ] Visual priority: snap > individual hover > section hover > individual selected > section selected > normal
- [ ] Labels unchanged on section hover (matching existing shot/station hover behavior)
- [ ] No pan/zoom on hover - only visual highlight
- [ ] Works in SingleSystemView only (where Sections panel exists)
- [ ] Unit tests for expression builder at `src/utils/maplibre-expressions.test.ts`
- [ ] Playwright E2E tests at `e2e-playwright/section-highlighting.spec.ts`
- [ ] WebdriverIO tests for accessibility + visual behavior
- [ ] `pnpm tsc --noEmit` passes
