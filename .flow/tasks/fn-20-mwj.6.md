# fn-20-mwj.6 Fix column widths for Length and Depth Out

## Description
Increase minimum column widths for "Length (m)" and "Depth Out" columns to prevent text wrapping.

**Size:** S
**Files:**
- `src/components/SingleSystemView/DataTable.tsx`

## Approach

1. Find columns array (lines 71-112)

2. Update width for Length column (line 95):
   - Current: `width: '80px'`
   - Change to: `width: '100px'` (or appropriate size to fit "Length (m)")

3. Update width for Depth Out column (line 99):
   - Current: `width: '80px'`
   - Change to: `width: '95px'` (or appropriate size to fit "Depth Out")

4. Test with various data to ensure no wrapping

## Key context

Current column definitions at DataTable.tsx:94-99:
```tsx
{ key: 'length', header: 'Length (m)', width: '80px', align: 'right' as const },
// ...
{ key: 'depth_out', header: 'Depth Out', width: '80px', align: 'right' as const },
```
## Acceptance
- [ ] "Length (m)" header fits on single line
- [ ] "Depth Out" header fits on single line
- [ ] Column widths appropriate for typical data values
- [ ] Table layout not broken by width changes
- [ ] Type check passes: `pnpm tsc --noEmit`
## Done summary
## Summary
Updated column widths for Length and Depth Out columns in DataTable.tsx to prevent text wrapping:
- Length (m): 80px → 100px
- Depth Out: 80px → 95px
## Evidence
- Commits:
- Tests: pnpm tsc --noEmit (passed), pnpm test:ui (464 passed)
- PRs: