# fn-20-mwj.2 Enhance EditableTable with row interactions and keyboard nav

## Description
Enhance the EditableTable component to support row-level interactions needed for DataTable improvements: click, double-click, hover, scroll-to-row, keyboard navigation (Enter/Shift+Enter), and row styling.

**Size:** M
**Files:**
- `src/components/common/Table.tsx` (EditableTable)
- `src/components/SingleSystemView/DataTable.tsx` (consumer updates)

## Approach

1. Add new optional props to EditableTableProps:
   - `onRowClick?: (item: T, index: number) => void`
   - `onRowDoubleClick?: (item: T, index: number) => void`
   - `onRowHover?: (item: T | null, index: number | null) => void`
   - `hoveredKey?: string | number | null` - for external hover state
   - `scrollToKey?: string | number | null` - triggers scroll-to-row
   - `rowClassName?: (item: T, isSelected: boolean, isHovered: boolean) => string`

2. Implement row event handlers:
   - Use `event.detail` to distinguish single vs double click
   - onMouseEnter/onMouseLeave for hover
   - Scroll using `scrollIntoView({ block: 'nearest' })` when scrollToKey changes

3. Implement keyboard navigation:
   - Enter: Move focus to same column in next row, enter edit mode
   - Shift+Enter: Move focus to same column in previous row, enter edit mode
   - Stay at boundary (no wrap)
   - Track focused column index across row changes

4. Row styling:
   - Selected: accent left border (`border-l-3 border-accent`)
   - Hovered: subtle background (`bg-accent/10`)
   - Follow pattern at SectionsPanel.tsx:218-219

## Key context

Memory pitfall: "Props used in setTimeout callbacks become stale closures - track them in a ref"
Memory convention: "Single event listener at root level to avoid duplicate subscriptions"

Current EditableTable at Table.tsx:104-217 has:
- `selectedKey` prop for selection highlighting
- Cell-level editing via double-click
- Tab/Shift+Tab for cell navigation
## Acceptance
- [ ] `onRowClick` fires on single-click anywhere on row
- [ ] `onRowDoubleClick` fires on double-click (single-click doesn't fire twice)
- [ ] `onRowHover` fires with item on mouse enter, null on mouse leave
- [ ] `hoveredKey` prop highlights the specified row
- [ ] `scrollToKey` prop scrolls row into view with minimal scroll
- [ ] Selected row has accent left border styling
- [ ] Hovered row has subtle background
- [ ] Enter key moves to cell below in same column and enters edit mode
- [ ] Shift+Enter moves to cell above in same column and enters edit mode
- [ ] At first/last row, Enter/Shift+Enter stays at boundary (no wrap)
- [ ] Existing cell editing (Tab, Shift+Tab) still works
- [ ] Type check passes: `pnpm tsc --noEmit`
## Done summary
Enhanced EditableTable component with row interactions (click, double-click, hover), scroll-to-row, keyboard navigation (Enter/Shift+Enter), and proper row styling with accent left border for selected rows and subtle background for hovered rows.
## Evidence
- Commits: 8526c18, 5e2e62d
- Tests: pnpm tsc --noEmit, pnpm test:ui
- PRs: