# fn-33-i3r.1 Replace border-left indicator with gradient pseudo-element bar

## Description

Replace the thin 2px `border-l-2 border-accent` selection indicator on the first `<td>` cell of selected data table rows with an 8px-wide gradient `::before` pseudo-element bar.

**Size:** M
**Files:**
- `src/index.css` — add `.selected-cell-indicator` class with `::before` pseudo-element
- `src/components/common/Table.tsx` — modify `getFirstCellBorderClass()` and first `<td>` rendering
- `e2e-playwright/panel-interactions.spec.ts` — add selection indicator assertions (if selection tests exist here)

## Approach

### 1. Add CSS class in `src/index.css`

Add a `.selected-cell-indicator` class after the existing checkbox/radio pseudo-element styles (~line 127). Follow the same pattern used at `src/index.css:105-127`:

- `position: relative` on the element
- `::before` pseudo-element with `position: absolute`, `content: ''`
- Gradient: `linear-gradient(to right, rgba(78, 205, 196, 0.3), transparent)`
- Dimensions: `width: 8px`, `top: 0`, `bottom: 0`, `left: 0`
- `pointer-events: none` to avoid capturing clicks
- No rounded corners, sharp edges

### 2. Modify `getFirstCellBorderClass()` in Table.tsx

At `src/components/common/Table.tsx:293-299`:

- Selected rows: return `'selected-cell-indicator'` (the new CSS class)
- Unselected rows: return empty string `''` (no space reservation needed — pseudo-element is absolutely positioned)
- Rename function to `getFirstCellSelectionClass()` to match new behavior

### 3. Add `data-selected` attribute for testability

At `src/components/common/Table.tsx:368`, add `data-selected={isSelected ? 'true' : undefined}` to the first `<td>` element. Pseudo-elements aren't in the DOM, so this attribute enables E2E test assertions.

### 4. Remove old border classes

- Remove `border-l-2 border-accent` (selected) and `border-l-2 border-transparent` (unselected) entirely
- The old approach reserved 2px for layout stability — no longer needed since pseudo-element doesn't affect layout

## Key context

- **Tauri desktop app** — targets Chromium WebView only, so `position: relative` on `<td>` is reliable
- **Project convention**: All custom CSS goes in `src/index.css`, not component-level CSS files
- **Existing pseudo-element pattern** at `src/index.css:105-127` (checkbox/radio `::after`) — follow same structure
- **No existing E2E tests** check for `border-l-2` on table rows (confirmed by grep)
- **fn-32-exw overlap**: Also modifies Table.tsx:368 for column alignment — different concern, low conflict risk
- **First column** in DataTable is `_warnings` with a render prop — the gradient sits behind this content via absolute positioning
- **Selected row background** is `bg-accent/20` — the 30% gradient overlays this subtly

## References

- `src/components/common/Table.tsx:293-299` — current `getFirstCellBorderClass()`
- `src/components/common/Table.tsx:368` — first `<td>` cell className
- `src/index.css:105-127` — existing pseudo-element pattern to follow
- `tailwind.config.js:23` — accent color `#4ecdc4`
- `src/components/SingleSystemView/DataTable.tsx:306-328` — selection state derivation
## Acceptance
- [ ] `.selected-cell-indicator` CSS class added to `src/index.css` with `::before` pseudo-element
- [ ] Gradient renders as 8px wide, accent at 30% opacity fading to transparent (left-to-right)
- [ ] `getFirstCellBorderClass()` replaced: returns new class for selected, empty string for unselected
- [ ] `data-selected="true"` attribute added to first `<td>` of selected rows
- [ ] Old `border-l-2 border-accent` and `border-l-2 border-transparent` completely removed
- [ ] No layout shift when selection changes (visual verification)
- [ ] Gradient bar spans full cell height with sharp edges
- [ ] `pointer-events: none` on pseudo-element (clicks pass through)
- [ ] The gradient indicator is static — does not animate or change on hover (existing row background hover via `getRowClassName()` is unmodified)
- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm test:ui` passes
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
