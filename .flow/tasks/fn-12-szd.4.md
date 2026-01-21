# fn-12-szd.4 Add double-click handler to SectionsPanel

## Description
Add double-click handler to section items in SectionsPanel that triggers zoom to section.

**Size:** S
**Files:** `src/components/SingleSystemView/SectionsPanel.tsx`

## Approach

- Add `onDoubleClick` handler to section list item at line 76
- Use React's native `onDoubleClick` event (NOT `event.detail === 2` pattern)
- Handler calls both `setSelection` (to select) and `triggerZoomToSection` (to zoom)
- Keep existing `onClick` handler for single-click selection
- Both handlers coexist cleanly - single click selects, double click selects AND zooms

## Key context

- Existing pattern: `onClick={handleSectionClick}` sets selection
- React's `onDoubleClick` fires after the click events, so selection happens first
- Both handlers can coexist since select + zoom is the desired double-click behavior
## Approach

- Add `onDoubleClick` handler to section list item at line 76
- Handler calls both `setSelection` (to select) and `triggerZoomToSection` (to zoom)
- Single-click continues to work as before (selection only)
- Use `event.detail === 2` check if needed to differentiate, but since both actions are additive (select + zoom), the natural browser behavior is acceptable

## Key context

- Existing pattern: `onClick={handleSectionClick}` sets selection
- Double-click fires after two single clicks (browser behavior)
- Both handlers can coexist since select + zoom is the desired double-click behavior
## Acceptance
- [ ] `onDoubleClick` handler added to section list items (using React native handler)
- [ ] Double-click selects section AND triggers zoom to section
- [ ] Single-click behavior unchanged (selection only)
- [ ] `pnpm tsc --noEmit` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
