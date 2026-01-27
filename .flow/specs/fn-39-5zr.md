# Bugfix: Section Highlighting Not Working for Hover and Selection

## Problem

When hovering or selecting a section in the SectionsPanel, no visual highlighting appears on the map. The SurveyLayer stores the hovered/selected section ID but never applies visual changes to the corresponding MapLibre features (shots and stations). Individual feature hover/selection works correctly — only section-level highlighting is missing.

## Current State

- **Panel UI**: SectionsPanel correctly dispatches `setHoveredSectionId()` and selection events to the uiStore
- **State management**: uiStore tracks `hoveredSectionId` and `selectedSectionId`
- **State sync**: MapCanvas syncs store state to SurveyLayer via `setHoveredSection()` and `setSelectedSection()`
- **SurveyLayer**: Stores the section IDs as `string | null` but `updateVisualState()` does NOT apply any visual changes for section-level highlighting
- **Individual features**: Station/shot hover and selection highlighting works correctly via `setFeatureState()` and `['feature-state', 'hover']` / `['feature-state', 'selected']` paint expressions
- **Feature properties**: All shot and station GeoJSON features already have a `sectionId` property (number type)

## Key Decisions

1. **Visual style**: Section hover and selection use the **same visual properties as individual feature hover/selection** (thicker line-width for shots, larger circle-radius + stroke changes for stations) — matching existing paint expressions exactly
2. **Section hover triggers**: Panel only — hovering shots/stations on the map does NOT trigger section-level highlighting
3. **Hover clears previous hover**: Hovering a new target (section or individual feature) always clears the previous hover. If a section is hovered via panel and then user hovers a map feature, the section hover clears
4. **Multi-section display**: One section can be **selected** while a **different** section is **hovered** — both are visible simultaneously on the map
5. **Hover over selected section**: Hover takes visual priority over selection on the same section
6. **No animation**: Highlighting changes are instant, no transitions
7. **All sections highlightable**: No exceptions — every section can be hovered and selected
8. **Implementation approach**: Choose the most maintainable and performant approach (feature-state iteration or data-driven paint expressions) — implementer's discretion

## Visual Priority Order (highest to lowest)

1. Individual feature hover (single station/shot hovered on map)
2. Section hover (all features in hovered section)
3. Individual feature selection (single station/shot selected on map)
4. Section selection (all features in selected section)
5. Base (default styling)

Note: Individual hover clears section hover (they don't coexist), but section selection and individual hover CAN coexist (selected section stays highlighted while individual feature is hovered).

## Edge Cases

- **Empty section**: A section with no shots/stations — highlight should be a no-op
- **Section with one feature**: Should highlight exactly like individual feature hover/selection
- **Rapid hover switching**: Moving mouse quickly across sections in the panel — previous section must fully clear before new one highlights
- **Type mismatch**: Feature properties store `sectionId` as `number`, SurveyLayer stores as `string | null` — comparison must handle this (use `['to-string', ['get', 'sectionId']]` or convert consistently)
- **Clear on navigation**: Follow existing behavior for clearing selection when navigating away from sections panel
- **Feature state cleanup**: When clearing section highlight, all features that had state set must be properly cleaned up

## Open Questions

- Need to verify whether the uiStore and MapCanvas state sync for `selectedSectionId` is fully wired (repo scout confirmed `hoveredSectionId` sync but selection path needs verification)
- Determine best approach: `setFeatureState()` loop vs data-driven paint expressions (implementer decides based on performance with 50-500 features per section)

## Acceptance

- [ ] Hovering a section in the SectionsPanel highlights all shots (thicker lines) and stations (larger circles + stroke) in that section on the map
- [ ] Selecting a section in the SectionsPanel highlights all shots and stations in that section on the map with selection styling
- [ ] Hovering a different section while one is selected shows both sections highlighted simultaneously
- [ ] Hovering the same section that is selected shows hover visual (hover priority over selection)
- [ ] Moving mouse from panel section hover to a map feature clears the section hover
- [ ] Individual feature hover/selection continues to work correctly
- [ ] Section highlighting clears properly when mouse leaves section in panel
- [ ] No visual transitions/animations — changes are instant
- [ ] All sections are highlightable without exceptions
- [ ] Type mismatch between number sectionId and string storage is handled correctly
- [ ] Tests are written for section highlighting behavior
