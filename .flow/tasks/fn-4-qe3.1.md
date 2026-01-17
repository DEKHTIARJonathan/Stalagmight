# fn-4-qe3.1 Add expandable section rows with LRUD columns

## Description
## Overview

Make section rows in DmpImportDialog expandable to show shot-level preview with LRUD columns (L, R, U, D).

## Implementation

### 1. Add expansion state
```tsx
const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set());
```

### 2. Make section rows clickable
Add chevron icon and toggle handler to section rows at line 286.

### 3. Create shot preview table
When section is expanded, show nested table with columns:
- Index (shot number)
- L (left passage width)
- R (right passage width)
- U (up/ceiling)
- D (down/floor)

### 4. LRUD display format
- Use pattern from DetailPanel: `shot.left?.toFixed(1) ?? '-'`
- Right-align numeric columns
- Show "-" for zero values (indicates "not measured")

### 5. Add data-testid attributes
- `section-expand-{index}` on expand button
- `shot-row-{sectionIndex}-{shotIndex}` on shot rows
- `lrud-left-{sectionIndex}-{shotIndex}` etc. on LRUD cells

## Files to Modify
- `src/components/Dialogs/DmpImportDialog.tsx`

## References
- LRUD pattern: `src/components/SingleSystemView/DetailPanel.tsx:346-356`
- DmpShot type: `src/types/commands.ts:38-56`
- Current section table: `DmpImportDialog.tsx:279-314`
## Acceptance
- [ ] Section rows have expand/collapse chevron
- [ ] Clicking section row toggles shot preview
- [ ] Shot table shows L, R, U, D columns
- [ ] LRUD values display with 1 decimal place
- [ ] Zero/null LRUD shows as "-"
- [ ] data-testid attributes present on all elements
- [ ] TypeScript types pass (`pnpm tsc --noEmit`)
- [ ] Visual styling matches existing table
## Done summary
Added expandable section rows with LRUD columns to DmpImportDialog. Section rows now have expand/collapse chevrons and clicking the row toggles shot preview with L, R, U, D columns. All values display with 1 decimal place, showing "-" for zero/null values.
## Evidence
- Commits: 2bf4668, 10076a3
- Tests: pnpm tsc --noEmit, pnpm test:ui
- PRs: