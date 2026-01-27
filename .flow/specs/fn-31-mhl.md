# Fix Select Dropdown Z-Index Behind Sticky Table Header

## Problem

The section selection dropdown in `DataTable.tsx` renders behind the sticky table headers. CSS `position: sticky` on table header cells (`Table.tsx`) creates a stacking context that traps the dropdown's `z-50` inside it, making the dropdown appear clipped/hidden beneath the header row.

## Key Decisions

- **Global portal approach**: Make the `Select` component (`src/components/common/Select.tsx`) portal-aware globally — all Select dropdowns will render via `createPortal` to `document.body`. This prevents the same stacking context bug from recurring anywhere else in the app.
- **Fixed positioning**: Use `position: fixed` with `getBoundingClientRect()` for portal dropdown placement — no scroll offset math needed.
- **Close on scroll**: The portaled dropdown closes when any scroll event is detected (window or container).
- **Match trigger width**: The portal dropdown width matches the trigger button width exactly (via `getBoundingClientRect().width`).
- **Flip upward when clipped**: Detect available viewport space below the trigger; if insufficient, open the dropdown upward instead.
- **Keep z-50**: The portal dropdown uses `z-50`, consistent with the existing z-index hierarchy (menus, context menus, dialogs all use z-50).
- **Preserve keyboard navigation**: Arrow keys, Enter to select, Escape to close must all work identically after portaling.
- **Keep existing event patterns**: Adapt the current `useEffect` event listeners for outside-click and keyboard handling — no hook extraction (scope creep for a bugfix).
- **No animation changes**: Keep the current instant show/hide behavior.
- **Check other dropdowns**: During implementation, verify if any other dropdowns in the data table area are also affected by the same stacking context issue.

## Edge Cases

- Dropdown near bottom of viewport should flip upward
- Scroll while dropdown is open should close it (any scroll source)
- Click outside (on trigger, on dropdown, or elsewhere) must behave correctly with portaled DOM
- Outside-click handler must check both the trigger element and the portaled dropdown element
- Keyboard focus must transfer correctly between trigger and portaled listbox
- Window resize while dropdown is open — reposition or close
- Multiple Select components on screen — only one dropdown open at a time

## Testing Requirements

Add Playwright e2e tests covering:
- [ ] Dropdown is visible above the sticky table header (not clipped)
- [ ] Dropdown closes when the table container or page is scrolled
- [ ] Keyboard navigation works (arrow keys, Enter to select, Escape to close)
- [ ] Clicking outside the dropdown closes it

## Acceptance

- [ ] Section selection dropdown in DataTable renders above the sticky table header
- [ ] All Select dropdowns across the app use portal rendering (global fix)
- [ ] Dropdown uses `position: fixed` with `getBoundingClientRect()` positioning
- [ ] Dropdown matches trigger button width
- [ ] Dropdown flips upward when insufficient space below
- [ ] Dropdown closes on any scroll event
- [ ] Click-outside detection works with portaled dropdown
- [ ] Full keyboard navigation preserved (arrow keys, Enter, Escape)
- [ ] Existing Select functionality and appearance unchanged (visual regression-free)
- [ ] Playwright e2e tests pass for dropdown visibility, scroll-close, keyboard nav, and click-outside
