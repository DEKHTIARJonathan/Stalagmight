## Description

Convert the Select component dropdown from `absolute z-50` positioning inside a `relative` container to portal rendering via `createPortal` to `document.body` with `position: fixed`. This is the core fix that escapes the stacking context created by sticky table headers.

**Size:** M
**Files:**
- `src/components/common/Select.tsx` (primary — all changes)

## Approach

### Portal rendering

Replace the dropdown div (line ~393, currently `absolute z-50 ...`) with `createPortal(<dropdown>, document.body)`. The portaled div uses `position: fixed` with inline styles for `top`, `left`, `width`, and `zIndex`.

Import `createPortal` from `react-dom`. Follow the pattern at `UndoHistoryDropdown.tsx:116-123`.

### Position calculation and flicker prevention

Gate the portal render to prevent a one-frame flash at wrong position. On open:
1. Set `isOpen` to true but render the portal with `visibility: hidden` initially
2. In `useLayoutEffect`, compute position from `triggerRef.current.getBoundingClientRect()`
3. Measure actual dropdown height via `dropdownRef.current.getBoundingClientRect().height` for accurate flip detection
4. Set position state and switch `visibility` to `visible`

Position coordinates:
- `left`: `rect.left`
- `width`: `rect.width` (matches trigger width)
- Default `top`: `rect.bottom` (dropdown opens below trigger)

Do NOT add `window.scrollX`/`window.scrollY` — `getBoundingClientRect()` returns viewport-relative coords and `position: fixed` is relative to viewport.

### Flip upward detection

After measuring actual dropdown height via `dropdownRef`, check if `rect.bottom + actualHeight > window.innerHeight`. If so, flip upward: `top = rect.top - actualHeight`. Clamp `top` to `>= 0` to prevent overflow above viewport top.

Follow viewport adjustment pattern at `ContextMenu.tsx:207-211`.

### Close on external scroll (not internal)

Add passive scroll listener on `window` (capture phase) that closes the dropdown, **but ignore scroll events whose `event.target` is inside the portaled listbox** (`dropdownRef.current?.contains(event.target as Node)`). This prevents closing when:
- User scrolls through long option lists inside the dropdown
- `scrollIntoView({ block: 'nearest' })` fires during keyboard navigation (line ~171)

Use `{ passive: true, capture: true }`. Clean up on effect teardown.

### Close on window resize

Same pattern as scroll: add resize listener on `window` when dropdown is open that closes it.

### Updated outside-click detection

Current pattern (lines 136-148) uses `containerRef.contains(event.target)`. This breaks with portal because dropdown is no longer inside `containerRef`.

Add a `dropdownRef` (useRef) attached to the portaled dropdown element. Update the mousedown handler to check both:
- `triggerRef.current?.contains(event.target as Node)` — click on trigger
- `dropdownRef.current?.contains(event.target as Node)` — click on portaled dropdown

If neither contains the target, close.

### Keyboard navigation

Keep `onKeyDown` on the trigger button (where it currently lives). Focus stays on trigger; `aria-activedescendant` points to the highlighted option in the portaled listbox. `scrollIntoView({ block: 'nearest' })` still works on portaled elements.

### Accessibility

Add `aria-owns={isOpen ? listboxId : undefined}` on the trigger button. This maintains the accessibility tree relationship between trigger and portaled listbox. The component already generates IDs via `useId()` (lines 124-126).

### Conditional portal rendering

Only render the portal when `isOpen` is true. When `isOpen` is false, render nothing for the dropdown (no DOM node in body).

## Key context

- `getBoundingClientRect()` returns viewport-relative coordinates — do NOT add scroll offsets when using `position: fixed`
- Memory pitfall: props in setTimeout callbacks become stale closures — track in refs (from project memory)
- Select is used in 9 locations: DataTable, SectionMetadataForm, DmpSectionConfigDialog, ExportDialog, MapSettings, DisplaySettings, GeneralSettings, ExportSettings, AdvancedSettings, UnitsSettings
- The `containerRef` currently wraps both trigger and dropdown (line ~352). With portal, it only wraps the trigger. Rename or repurpose accordingly.
- Grouped options support (`isGroupedOptions()` at lines 42-44) must still work with portaled rendering
- `useId()` at lines 124-126 generates `triggerId`, `listboxId`, `getOptionId` — reuse for `aria-owns`
- Internal scroll (user scrolling options, `scrollIntoView`) must NOT trigger close — filter by `dropdownRef.contains(event.target)`

## Acceptance

- [ ] Select dropdown renders via `createPortal` to `document.body`
- [ ] Dropdown uses `position: fixed` with coordinates from `getBoundingClientRect()`
- [ ] No flicker on open (visibility:hidden until position computed in useLayoutEffect)
- [ ] Dropdown width matches trigger button width
- [ ] Dropdown flips upward when insufficient viewport space below (actual height measured, top clamped >= 0)
- [ ] Dropdown closes on external scroll events (window, table container, etc.)
- [ ] Dropdown does NOT close on internal scroll (scrolling through options, scrollIntoView)
- [ ] Dropdown closes on window resize
- [ ] Outside-click detection checks both triggerRef and dropdownRef
- [ ] Keyboard navigation works identically (ArrowDown, ArrowUp, Home, End, Enter/Space, Escape, Tab)
- [ ] `aria-owns` set on trigger when dropdown is open
- [ ] Grouped options render correctly in portaled dropdown
- [ ] All 9 Select usage sites work correctly (no visual regression)
- [ ] Section selection dropdown in DataTable is visible above sticky table header
- [ ] `pnpm tsc --noEmit` passes

## Done summary
Converted Select dropdown from absolute positioning to portal rendering via createPortal to document.body with position:fixed, escaping stacking contexts like sticky table headers. Implemented flicker-free positioning with useLayoutEffect, upward flip detection with actual height measurement, close on external scroll/resize, updated outside-click detection for portal, and aria-owns for accessibility.
## Evidence
- Commits: 01f4a169c0c9edf2f9f2fdc2f78ae16f2b8fb5ab, 3bc919977426057aaf2e8687c9d4d0b268564493
- Tests: pnpm tsc --noEmit
- PRs: