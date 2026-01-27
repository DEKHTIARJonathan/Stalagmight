# Fix Select Dropdown Z-Index Behind Sticky Table Header

## Overview

The section selection dropdown in `DataTable.tsx` renders behind sticky table headers because CSS `position: sticky` with `z-10` on table header cells creates a stacking context that traps the dropdown's `z-50`. Fix by making the `Select` component globally portal-aware — all Select dropdowns render via `createPortal` to `document.body` with `position: fixed` placement.

## Scope

**In scope:**
- Portal rendering for all Select dropdowns (global fix in Select.tsx)
- `position: fixed` with `getBoundingClientRect()` positioning
- Match trigger button width
- Flip upward when insufficient viewport space below
- Close on any scroll event
- Close on window resize
- Updated outside-click detection for portaled DOM
- Keyboard navigation preservation
- `aria-owns` for portal accessibility
- Playwright e2e tests
- TESTING.md update for Select portal test patterns

**Out of scope:**
- Changes to Table.tsx sticky header z-index
- Other dropdown components (UndoHistoryDropdown, ContextMenu)
- Animation changes
- Touch-specific handling (mousedown already covers touch via browser normalization in desktop Tauri app)

## Approach

### Portal rendering

Replace the `absolute z-50` dropdown div (line ~393) with `createPortal(..., document.body)`. The portaled div uses `position: fixed` with coordinates from `getBoundingClientRect()` on the trigger button.

Use `useLayoutEffect` (not `useEffect`) for position calculation to avoid flicker — position must be set before browser paint.

### Positioning

Calculate position from `triggerRef.current.getBoundingClientRect()`:
- `top`: `rect.bottom` (below trigger)
- `left`: `rect.left`
- `width`: `rect.width` (match trigger width)

Do NOT add `window.scrollX`/`window.scrollY` — `getBoundingClientRect()` already returns viewport-relative coords, and `position: fixed` is relative to viewport.

### Flip upward

After calculating dropdown position, check if `rect.bottom + dropdownHeight > window.innerHeight`. If so, flip: set `top` to `rect.top - dropdownHeight` instead. Use a ref on the portaled dropdown to measure its height after first render, or estimate from `max-h-60` (240px).

Follow the viewport adjustment pattern at `ContextMenu.tsx:207-211`.

### Close on scroll and resize

Add passive scroll listener on `window` (capture phase to catch all scroll sources) that calls `setIsOpen(false)`. Add resize listener similarly. Both clean up on effect teardown or dropdown close.

Use `{ passive: true, capture: true }` for scroll listener to catch scroll events from any container.

### Outside-click detection

The current `containerRef.contains(event.target)` pattern (lines 136-148) will break because the portaled dropdown is no longer inside `containerRef`. Add a `dropdownRef` on the portaled listbox element. Check both:
- `triggerRef.current?.contains(event.target as Node)`
- `dropdownRef.current?.contains(event.target as Node)`

If neither contains the target, close the dropdown.

### Keyboard navigation

Keyboard events are currently handled on the container div (line ~219). With portal, the trigger button still receives keyboard events. Keep `onKeyDown` on the trigger button. The portaled dropdown doesn't need its own keyboard handler since focus stays on the trigger and uses `aria-activedescendant`.

`scrollIntoView({ block: 'nearest' })` on highlighted option (line ~171) still works because the portaled dropdown is in the DOM — just at a different location.

### Accessibility

Add `aria-owns={isOpen ? listboxId : undefined}` on the trigger button to maintain the accessibility tree relationship with the portaled listbox. The component already uses `useId()` for ARIA IDs (lines 124-126).

### Key reuse points

- Portal pattern: `UndoHistoryDropdown.tsx:116-123` (createPortal, position:fixed, zIndex)
- Viewport adjustment: `ContextMenu.tsx:207-211`
- Toast portal: `App.tsx:567-581` (createPortal to document.body)
- Outside-click: current Select.tsx pattern (lines 136-148), adapted for portal

## Risks / Dependencies

- **fn-34-0k5 overlap**: Epic fn-34-0k5 also modifies Select.tsx (adds `onOptionHover` prop). These epics touch the same file. Whichever lands first, the other must merge cleanly. The changes are orthogonal (portal rendering vs. hover callback), so conflicts should be minimal.
- **9 usage sites**: Select is used in DataTable, SectionMetadataForm, DmpSectionConfigDialog, ExportDialog, and 5 Settings panels. All must continue working after portal change. Visual regression risk is low since only DOM placement changes, not styling.
- **Stale closures**: Props in setTimeout callbacks can become stale — track in refs (from project memory).

## Quick commands

```bash
# Type check
pnpm tsc --noEmit

# E2E tests (select-specific)
pnpm test:ui -- --grep "select"

# All E2E tests
pnpm test:ui

# Rust tests (unchanged, sanity check)
cargo test --manifest-path src-tauri/Cargo.toml
```

## Acceptance

- [ ] Section selection dropdown in DataTable renders above the sticky table header
- [ ] All Select dropdowns across the app use portal rendering (global fix)
- [ ] Dropdown uses `position: fixed` with `getBoundingClientRect()` positioning
- [ ] Dropdown matches trigger button width
- [ ] Dropdown flips upward when insufficient space below
- [ ] Dropdown closes on any scroll event
- [ ] Dropdown closes on window resize
- [ ] Click-outside detection works with portaled dropdown (checks both trigger and dropdown refs)
- [ ] Full keyboard navigation preserved (arrow keys, Enter, Escape, Tab)
- [ ] `aria-owns` set on trigger when dropdown is open
- [ ] Existing Select functionality and appearance unchanged across all 9 usage sites
- [ ] Playwright e2e tests pass for dropdown visibility, scroll-close, keyboard nav, and click-outside
- [ ] TESTING.md updated with Select portal test patterns

## References

- Select component: `src/components/common/Select.tsx`
- Table sticky header: `src/components/common/Table.tsx:53,310`
- DataTable usage: `src/components/SingleSystemView/DataTable.tsx:428-435`
- Portal pattern: `src/components/SingleSystemView/UndoHistoryDropdown.tsx:116-123`
- Viewport adjustment: `src/components/common/ContextMenu.tsx:207-211`
- Toast portal: `src/App.tsx:567-581`
- E2E tests: `e2e-playwright/`
- TESTING.md: `docs/TESTING.md`
