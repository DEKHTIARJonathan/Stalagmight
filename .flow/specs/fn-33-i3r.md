# Enhance Data Table Shot Selection Indicator

## Overview

Replace the thin 2px solid left border on selected data table rows with an 8px-wide gradient bar implemented as a CSS `::before` pseudo-element. The gradient fades from accent color at 30% opacity to transparent (left-to-right). Zero layout shift — the bar sits behind row content as a background layer.

## Scope

**In scope:**
- Modify `getFirstCellBorderClass()` in Table.tsx to use a `::before` pseudo-element gradient bar
- Add a CSS class in `src/index.css` for the pseudo-element (project convention: all custom CSS in index.css)
- Add `data-selected` attribute for testability (pseudo-elements aren't in DOM)
- Remove old `border-l-2 border-accent` / `border-l-2 border-transparent` approach

**Out of scope:**
- SectionsPanel selection indicator (uses same `border-l-2` but in DmpSectionConfigDialog.tsx — different component)
- Animation/transitions
- Row-level hover behavior changes (existing `hover:bg-accent/10` on all rows remains unchanged)
- Other table consumers besides DataTable

## Approach

### Why custom CSS in index.css (not pure Tailwind)?

The `::before` pseudo-element needs `position: relative` on its parent. CSS spec doesn't define `position: relative` for `display: table-cell` — browsers are inconsistent. Two options:

1. **Wrapper div inside `<td>`** — adds DOM depth to every cell, changes layout structure
2. **CSS class on `<td>`** using `position: relative` — works in practice for modern Chrome/Firefox/Safari (the actual target platforms for this Tauri desktop app)

Option 2 is simpler since this is a desktop app targeting Chromium (Tauri WebView). Define a `.selected-cell-indicator` class in index.css with the pseudo-element, and conditionally apply it via the existing `getFirstCellBorderClass()` function.

### Key implementation details

- **Gradient**: `linear-gradient(to right, rgba(78, 205, 196, 0.3), transparent)` — accent (#4ecdc4) at 30% opacity fading to transparent
- **Width**: 8px (`width: 8px`)
- **Height**: full cell height (`top: 0; bottom: 0`)
- **Positioning**: `position: absolute; left: 0` on pseudo-element, `position: relative` on the `<td>`
- **No pointer events**: `pointer-events: none` on pseudo-element
- **No layout shift**: Remove `border-l-2 border-transparent` from unselected rows — the pseudo-element is absolutely positioned and doesn't affect layout
- **Content**: `content: ''` (empty — purely decorative)

### Testing strategy

Pseudo-elements aren't in the DOM, so Playwright can't query them directly. Add `data-selected="true"` to selected first-cell `<td>` elements. E2E tests verify:
- `data-selected` attribute present on selected row's first cell
- `data-selected` absent on unselected rows
- Selection state changes correctly when clicking rows / map markers

No existing E2E tests check for `border-l-2` on table rows (confirmed by grep), so no test updates needed — only new assertions.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| `position: relative` on `<td>` may not work in some browsers | Tauri uses Chromium WebView — tested platform. Not a general web app |
| fn-32-exw also modifies Table.tsx:368 | Different concerns (alignment vs indicator). Low merge conflict risk — coordinate merge order |
| Gradient blends with `bg-accent/20` selected row background | 30% opacity gradient on top of 20% background is still subtle — verify visually |

## Quick commands

```bash
# Type check
pnpm tsc --noEmit

# Run E2E tests
pnpm test:ui

# Dev server for visual verification
./scripts/dev.sh
```

## Acceptance

- [ ] Selected shot row shows an 8px-wide gradient bar on the left (accent at 30% opacity → transparent)
- [ ] Gradient is implemented as a `::before` pseudo-element, not a border
- [ ] No layout shift when selection changes
- [ ] Gradient bar spans full row height with sharp edges
- [ ] The gradient indicator itself is static — it does not animate or change on hover (existing row background hover behavior is unmodified)
- [ ] Unselected rows show no indicator at all
- [ ] The old 2px border-left is completely removed
- [ ] `data-selected` attribute added for testability
- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm test:ui` passes

## References

- `src/components/common/Table.tsx:293-299` — current `getFirstCellBorderClass()`
- `src/components/common/Table.tsx:368` — first `<td>` className application
- `src/components/common/Table.tsx:269-289` — `getRowClassName()` with hover logic (unchanged)
- `src/index.css:105-127` — existing pseudo-element pattern (checkbox/radio)
- `tailwind.config.js:23` — accent color `#4ecdc4`
- `src/components/SingleSystemView/DataTable.tsx:454` — EditableTable consumer
