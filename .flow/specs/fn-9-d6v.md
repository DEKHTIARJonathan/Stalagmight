# Section Hover/Selection Highlighting on Map

## Problem
When users hover or select a section in the Sections panel, nothing happens on the map. Users expect to see all shots and stations belonging to that section highlighted on the map, similar to how individual shots/stations highlight when hovered on the map.

Additionally, the interaction should be bidirectional: hovering shots/stations on the map should highlight the corresponding section row in the Sections panel.

## Approach

### State Management (uiStore)
Add `hoveredSectionId: SectionId | null` to uiStore with `setHoveredSectionId` action. This enables bidirectional sync:
- Sections panel sets it on row hover/focus
- MapCanvas derives it when shots/stations are hovered on map (from feature's sectionId)

### SurveyLayer API
Add methods following existing patterns:
- `setHoveredSection(sectionId: SectionId | null)`
- `setSelectedSection(sectionId: SectionId | null)`

Store internally as `hoveredSectionId` and `selectedSectionId`.

### MapLibre Expression Builder
Create `src/utils/maplibre-expressions.ts` with pure function:
```typescript
buildPriorityExpression(priorities: {condition: Expression, value: any}[], fallback: any): Expression
```

Refactor `updateVisualState()` to use this builder for cleaner priority logic.

### Visual Priority Order (highest to lowest)
1. Snap (4px stroke, #00ffcc)
2. Individual hover (3px stroke, #0066ff)
3. **Section hover (3px stroke, #0066ff)** - NEW
4. Individual selected (2px stroke, #00aaff)
5. **Section selected (2px stroke, #00aaff)** - NEW
6. Normal (1px stroke, #000000)

### MapLibre Expressions
Use `['==', ['get', 'sectionId'], hoveredSectionId]` to match all features in a section. Features already have `sectionId` property.

### Sections Panel Changes
- Add `onMouseEnter`/`onMouseLeave` handlers to section rows
- Add keyboard accessibility: `role="listbox"`, rows as `role="option"`
- Arrow key navigation with DOM focus movement
- `onFocus` triggers same hover highlight as mouse
- Enter/Space to select
- Escape to clear selection (calls existing `clearSelection()`)
- `data-testid="section-row-{id}"` for E2E testing
- Show `bg-accent/20` background when:
  - Row is selected
  - Row is hovered (mouse or keyboard focus)
  - Section's features are hovered on map (bidirectional)

### MapCanvas Integration
Extend existing selection sync effect to handle section type:
```typescript
if (selection?.type === 'section' && selection.sectionId) {
  surveyLayerRef.current.setSelectedSection(selection.sectionId);
} else {
  surveyLayerRef.current.setSelectedSection(null);
}
```

Add new effect for hover sync from uiStore to SurveyLayer.

Derive hoveredSectionId from map hover callbacks (StationRef has section_id).

## Edge Cases
- Empty sections (no shots): Still interactive, just no map highlight
- Virtual shots: Include in highlight (same visual treatment as real shots)
- Merged stations: Only highlight stations belonging to hovered section, not merge partners
- Loop closures: Don't highlight with section hover (separate visualization)
- Merge connection lines: No change on section hover
- Hover overrides selection: When different section is hovered while one is selected, hover visuals take precedence
- Same section hovered+selected: Hover appearance (consistent with priority rule)

## Quick commands
```bash
# Type check
pnpm tsc --noEmit

# Run all tests
pnpm test:ui
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
- [ ] Comprehensive unit tests for expression builder
- [ ] Extensive Playwright E2E tests for all scenarios
- [ ] WebdriverIO tests for accessibility + visual behavior
- [ ] `pnpm tsc --noEmit` passes
