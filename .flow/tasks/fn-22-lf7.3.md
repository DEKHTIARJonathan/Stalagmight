# fn-22-lf7.3 Add hover/focus handlers to DetailLink

## Description

Add onMouseEnter/onMouseLeave/onFocus/onBlur handlers to DetailLink that highlight the corresponding map element. The handlers call uiStore setters based on link type (station/shot/section).

**Size:** M
**Files:**
- `src/components/common/DetailLink.tsx` (main changes)
- `src/components/SingleSystemView/DetailPanel.tsx` (pass callbacks/data)

## Approach

### DetailLink changes:
1. Add optional callback props: `onHoverStart?: () => void`, `onHoverEnd?: () => void`
2. Add mouse/focus handlers to the button element
3. Handle focus vs hover interaction per memory pitfall: "Mouse leave handlers must check if keyboard focus is active"
4. Skip hover for isMissing links (graceful degradation)

### DetailPanel changes:
1. Create hover callbacks that call uiStore setters:
   - Station: `setHoveredStation({ section_id: target.sectionId, station_index: target.position - 1 })`
   - Shot: `setHoveredShot({ sectionId: target.sectionId, shotId: section.shots[target.position - 1].id })`
   - Section: `setHoveredSectionId(target.sectionId)`
2. Pass callbacks to DetailLink via onHoverStart/onHoverEnd

### Focus/hover interaction:
- Both focus and hover set the highlight
- onMouseLeave only clears if element is NOT focused (use document.activeElement check)
- onBlur clears unconditionally

## Key Context

- Position is 1-indexed in DetailLink target, but station_index is 0-indexed
- Shot ID must be looked up from section.shots array by position
- Memory pitfall: "Mouse leave handlers must check if keyboard focus is active to avoid clearing highlight"
## Acceptance
- [ ] DetailLink accepts onHoverStart and onHoverEnd optional props
- [ ] onMouseEnter calls onHoverStart (if not isMissing)
- [ ] onMouseLeave calls onHoverEnd (if element is not focused)
- [ ] onFocus calls onHoverStart (if not isMissing)
- [ ] onBlur calls onHoverEnd
- [ ] Station links in DetailPanel highlight correct station on hover
- [ ] Shot links in DetailPanel highlight correct shot on hover
- [ ] Section links in DetailPanel highlight all section elements on hover
- [ ] isMissing links do not trigger hover (silent no-op)
- [ ] Tab-focusing a link shows the same highlight as mouse hover
- [ ] Position-to-index conversion is correct (1-indexed to 0-indexed)
- [ ] Shot position-to-shotId lookup is correct
- [ ] Update DetailLink JSDoc to document hover behavior
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
