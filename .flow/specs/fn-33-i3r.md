# Enhance Data Table Shot Selection Indicator

## Problem
When a shot is selected (via clicking a table row or clicking on the map), the data table highlights it with only a thin 2px left border (`border-l-2 border-accent`). This is hard to see and not aesthetically pleasing. The indicator needs to be more visible and visually appealing.

## Solution
Replace the thin 2px solid border with an 8px-wide gradient bar on the left side of the selected shot row. The bar uses a CSS `::before` pseudo-element positioned behind the row content, so there is zero layout shift — the row content stays exactly where it is.

## Key Decisions

- **Visual style**: 8px-wide gradient bar (replaces the current 2px solid border entirely)
- **Gradient direction**: Left-to-right — solid accent at the left edge fading to fully transparent at 8px in (horizontal fade, "inside-to-outside")
- **Gradient opacity**: Starts at 30% opacity of accent color (`#4ecdc4` at 30% → transparent`)
- **Implementation technique**: CSS `::before` pseudo-element on the first `<td>` cell, absolutely positioned behind content
- **Layout shift**: None — the gradient sits underneath (behind) the row content as a background layer; no padding or spacing changes
- **Bar shape**: Sharp edges (no rounded corners), full row height (no vertical margin/gap)
- **Scope**: Single selected shot row only (shot/station selection), not section-level
- **Animation**: None — highlight appears instantly
- **Hover behavior**: Selected rows do not change on hover (already visually distinct)
- **Unselected rows**: No space reserved — the pseudo-element simply doesn't render, content position unchanged
- **Consistency scope**: Data table only — SectionsPanel and other panels unchanged

## Edge Cases

- When no shot is selected, no rows show the gradient bar
- When switching between shots, the bar moves instantly (no animation)
- The gradient must not interfere with cell content readability (30% opacity ensures this)
- The pseudo-element must not capture click/pointer events (use `pointer-events: none`)
- Table scrolling must not cause visual artifacts with the positioned pseudo-element

## Files Involved

- `src/components/common/Table.tsx` — modify `getFirstCellBorderClass()` and the first-cell `<td>` rendering to use `::before` pseudo-element instead of `border-l-2`
- `tailwind.config.js` — may need custom utility or arbitrary value support (though Tailwind v3 arbitrary values should suffice)
- E2E tests that check for the `border-l-2` class — update assertions

## Acceptance

- [ ] Selected shot row shows an 8px-wide gradient bar on the left (accent at 30% opacity → transparent)
- [ ] Gradient is implemented as a `::before` pseudo-element behind content, not a border
- [ ] No layout shift when selection changes — row content stays in place
- [ ] Gradient bar spans full row height with sharp edges
- [ ] Hover does not change the appearance of a selected row
- [ ] Unselected rows show no indicator at all
- [ ] The old 2px border-left is completely removed
- [ ] Existing E2E tests updated to verify the new indicator
- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm test:ui` passes
