# Fix Select Dropdown Z-Index Behind Sticky Table Header

## Overview

The section selection dropdown in `DataTable.tsx` renders behind sticky table headers because CSS `position: sticky` with `z-10` on table header cells creates a stacking context that traps the dropdown's `z-50`. Fix by making the `Select` component globally portal-aware — all Select dropdowns render via `createPortal` to `document.body` with `position: fixed` placement.

## Scope

**In scope:**
- Portal rendering for all Select dropdowns (global fix in Select.tsx)
- `position: fixed` with `getBoundingClientRect()` positioning
- Match trigger button width
- Flip upward when insufficient viewport space below (measure actual height, clamp top >= 0)
- Close on external scroll events (ignore scroll inside the portaled dropdown itself)
- Close on window resize
- Updated outside-click detection for portaled DOM
- Keyboard navigation preservation
- `aria-owns` for portal accessibility
- Gate portal render on position-ready (prevent flash at wrong position)
- Playwright e2e tests (including updating existing tests broken by portal change)
- TESTING.md update for Select portal test patterns

**Out of scope:**
- Changes to Table.tsx sticky header z-index
- Other dropdown components (UndoHistoryDropdown, ContextMenu)
- Animation changes
- Touch-specific handling (mousedown already covers touch via browser normalization in desktop Tauri app)

## Approach

### Portal rendering

Replace the `absolute z-50` dropdown div (line ~393) with `createPortal(..., document.body)`. The portaled div uses `position: fixed` with coordinates from `getBoundingClientRect()` on the trigger button.

### Position calculation and flicker prevention

Gate the portal render on "position ready" state. On open:
1. Set `isOpen` to true but render the portal with `visibility: hidden` initially
2. In `useLayoutEffect`, compute position from `triggerRef.current.getBoundingClientRect()`
3. Measure actual dropdown height via `dropdownRef.current.getBoundingClientRect().height` for accurate flip detection
4. Set position state and flip `visibility` to `visible`

This prevents a one-frame flash at (0,0) or wrong position.

Position coordinates:
- `left`: `rect.left`
- `width`: `rect.width` (matches trigger width)
- Default `top`: `rect.bottom` (dropdown opens below trigger)

Do NOT add `window.scrollX`/`window.scrollY` — `getBoundingClientRect()` already returns viewport-relative coords and `position: fixed` is relative to viewport.

### Flip upward detection

After measuring actual dropdown height via `dropdownRef`, check if `rect.bottom + actualHeight > window.innerHeight`. If so, flip: `top = rect.top - actualHeight`. Clamp `top` to `>= 0` to prevent overflow above viewport. This replaces the previous approach of estimating from `max-h-60`.

Follow viewport adjustment pattern at `ContextMenu.tsx:207-211`.

### Close on external scroll (not internal)

Add passive scroll listener on `window` (capture phase) that closes the dropdown, **but ignore scroll events whose `event.target` is inside the portaled listbox** (`dropdownRef.current?.contains(event.target as Node)`). This prevents:
- Closing when user scrolls through long option lists inside the dropdown
- Closing when `scrollIntoView()` fires during keyboard navigation

Use `{ passive: true, capture: true }` for the scroll listener. Clean up on effect teardown.

### Close on window resize

Add resize listener on `window` when dropdown is open that closes it. Clean up on teardown.

### Outside-click detection

The current `containerRef.contains(event.target)` pattern (lines 136-148) will break because the portaled dropdown is no longer inside `containerRef`. Add a `dropdownRef` on the portaled listbox element. Check both:
- `triggerRef.current?.contains(event.target as Node)`
- `dropdownRef.current?.contains(event.target as Node)`

If neither contains the target, close the dropdown.

### Keyboard navigation

Keyboard events are currently handled on the container div (line ~219). With portal, the trigger button still receives keyboard events. Keep `onKeyDown` on the trigger button. The portaled dropdown doesn't need its own keyboard handler since focus stays on the trigger and uses `aria-activedescendant`.

`scrollIntoView({ block: 'nearest' })` on highlighted option still works because the portaled dropdown is in the DOM.

### Accessibility

Add `aria-owns={isOpen ? listboxId : undefined}` on the trigger button to maintain the accessibility tree relationship with the portaled listbox. The component already uses `useId()` for ARIA IDs (lines 124-126).

### Key reuse points

- Portal pattern: `UndoHistoryDropdown.tsx:116-123` (createPortal, position:fixed, zIndex)
- Viewport adjustment: `ContextMenu.tsx:207-211`
- Toast portal: `App.tsx:567-581` (createPortal to document.body)
- Outside-click: current Select.tsx pattern (lines 136-148), adapted for portal

## Risks / Dependencies

- **fn-34-0k5 overlap**: Epic fn-34-0k5 also modifies Select.tsx (adds `onOptionHover` prop). These epics touch the same file. Whichever lands first, the other must merge cleanly. The changes are orthogonal (portal rendering vs. hover callback), so conflicts should be minimal.
- **9 usage sites**: Select is used in DataTable, SectionMetadataForm, DmpSectionConfigDialog, ExportDialog, and 5 Settings panels. All must continue working after portal change.
- **Existing e2e tests will break**: Tests using `.absolute` selector or scoping options under the select container (export-dialog.spec.ts, panel-interactions.spec.ts, id-zero-regression.spec.ts, export-preview.spec.ts, export-color-modes.spec.ts) will break because the listbox moves to `document.body`. All must be updated.
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
- [ ] No flicker on open (position-ready gating or visibility:hidden until computed)
- [ ] Dropdown matches trigger button width
- [ ] Dropdown flips upward when insufficient space below (measured actual height, top clamped >= 0)
- [ ] Dropdown closes on external scroll events (not on internal dropdown scroll or scrollIntoView)
- [ ] Dropdown closes on window resize
- [ ] Click-outside detection works with portaled dropdown (checks both trigger and dropdown refs)
- [ ] Full keyboard navigation preserved (arrow keys, Enter, Escape, Tab)
- [ ] `aria-owns` set on trigger when dropdown is open
- [ ] Existing Select functionality and appearance unchanged across all 9 usage sites
- [ ] All existing e2e tests updated to work with portaled Select (no `.absolute` selectors)
- [ ] New Playwright e2e tests for dropdown visibility (using elementFromPoint for z-order proof), scroll-close, keyboard nav, click-outside
- [ ] TESTING.md updated with Select portal test patterns

## References

- Select component: `src/components/common/Select.tsx`
- Table sticky header: `src/components/common/Table.tsx:53,310`
- DataTable usage: `src/components/SingleSystemView/DataTable.tsx:428-435`
- Portal pattern: `src/components/SingleSystemView/UndoHistoryDropdown.tsx:116-123`
- Viewport adjustment: `src/components/common/ContextMenu.tsx:207-211`
- Toast portal: `src/App.tsx:567-581`
- Existing tests using `.absolute` selector: `e2e-playwright/export-dialog.spec.ts`, `export-preview.spec.ts`, `export-color-modes.spec.ts`, `panel-interactions.spec.ts`, `id-zero-regression.spec.ts`
- TESTING.md: `docs/TESTING.md`
