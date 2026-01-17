# Task 49: Virtual Scrolling for Data Table

## Overview
Implement windowed rendering using TanStack Virtual for the data table. Note: May be overkill for <100 shots per section, but prepares for future growth.

## Priority
Medium - Phase F (Performance)

## Risk Level
Medium

## Dependencies
- Existing Table component

## Files to Modify
- `src/components/common/Table.tsx` - Add virtualization
- `src/components/SingleSystemView/DataTable.tsx` - Wire up virtual scroll
- `package.json` - Add @tanstack/react-virtual

## Specifications

### Library Choice
TanStack Virtual (formerly react-virtual):
```bash
pnpm add @tanstack/react-virtual
```

### Implementation Pattern
```tsx
import { useVirtualizer } from '@tanstack/react-virtual';

function VirtualTable({ rows }) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32, // row height
    overscan: 5,
  });

  return (
    <div ref={parentRef} style={{ height: '400px', overflow: 'auto' }}>
      <div style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <TableRow
            key={virtualRow.key}
            style={{
              position: 'absolute',
              top: virtualRow.start,
              height: virtualRow.size,
            }}
            data={rows[virtualRow.index]}
          />
        ))}
      </div>
    </div>
  );
}
```

### Scroll Position Preservation
- Maintain scroll position on data change
- Store position before update
- Restore after render

### Dynamic Row Heights
- Support variable row heights
- Measure after render if needed
- Cache measured heights

### Sticky Header
- Table header always visible
- Separate from virtual scroll container
- Synced horizontal scroll with body

### Performance Targets
- Smooth scroll at 60fps
- Handle 10,000 rows
- No jank on data updates

### Current Reality
- Most sections have <100 shots
- Virtualization may be unnecessary
- But infrastructure prepares for growth

### Fallback
- If <50 rows, render all (no virtualization)
- Threshold configurable
- Reduces complexity for small tables

## Acceptance Criteria
- [ ] TanStack Virtual integrated
- [ ] Smooth scrolling with large datasets
- [ ] Scroll position preserved on updates
- [ ] Sticky header works
- [ ] Falls back for small datasets
- [ ] TypeScript types pass
- [ ] Tests pass

## Test Requirements

### Playwright Tests (Mocked IPC)
1. Test table renders with TanStack Virtual
2. Test only visible rows in DOM (check element count)
3. Test scroll renders new rows
4. Test scroll position preserved on data update
5. Test sticky header stays visible during scroll
6. Test fallback for <50 rows (no virtualization)
7. Test overscan renders buffer rows

### WebdriverIO Tests (Full App)
1. Test scroll performance with 1000 rows (60fps)
2. Test scroll performance with 5000 rows
3. Test memory usage stays bounded
4. Test rapid scroll doesn't cause flicker
5. Test virtualization with real survey data

## Edge Cases
- Empty table
- Single row
- Very wide rows
- Rapid scroll
- Data change during scroll
