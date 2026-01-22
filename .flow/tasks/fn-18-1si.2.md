# fn-18-1si.2 Add selection stats to DmpSelectionDialog

## Description
Update DmpSelectionDialog to show selection-based statistics in the metadata header, replacing file-level totals with stats for currently selected sections.

**Size:** S
**Files:** `src/components/Dialogs/DmpSelectionDialog.tsx`

## Approach

1. Import `useProjectStore` for config access (follow `DmpImportDialog.tsx:259` pattern)
2. Import formatting utilities from `src/utils/formatStats.ts`
3. Modify `calculateMetadata` function (lines 35-68) to:
   - Accept `selectedIndices` as parameter
   - Filter sections by selectedIndices before calculating
   - **Filter shots to `shot_type === 'Standard'` only** (matches existing pattern)
   - **Exclude negative lengths from total** (data corruption guard)
   - **Use `Number.isFinite()` for depth values** (exclude NaN/Infinity)
   - Add depth range calculation (min/max of depth_in/depth_out from filtered shots)
4. Update useMemo call to pass `selectedIndices` dependency
5. Update metadata header (lines 219-237) to show new stats format with "Depth: " prefix

## Key context

Current `calculateMetadata` signature (line 35):
```typescript
function calculateMetadata(dmpFile: DmpFile)
```

Change to:
```typescript
function calculateMetadata(dmpFile: DmpFile, selectedIndices: Set<number>)
```

**Filtering pattern** (from DmpImportDialog.tsx:69-98):
```typescript
const standardShots = section.shots.filter(s => s.shot_type === 'Standard');
```

Stats format: `{shots} shots | {length} | Depth: {range}`
Example: `15 shots | 42.3m | Depth: 2.1-15.4m`

## Acceptance
- [ ] Stats in metadata header show selection-based values (not file totals)
- [ ] Stats update in real-time when checkboxes toggled
- [ ] Shows "0 shots | 0.0m | Depth: --" when no sections selected
- [ ] Only counts Standard shots (shot_type === 'Standard')
- [ ] Excludes negative length values from total
- [ ] Excludes non-finite depth values (NaN, Infinity) from range calculation
- [ ] Depth range calculated from min/max of depth_in/depth_out of Standard shots
- [ ] Unit conversion applied based on config.units.length and config.units.depth
- [ ] Uses pipe separators with "Depth: " prefix: `shots | length | Depth: range`
- [ ] File name and version remain visible in header
- [ ] Test ID `selection-stats` on container
- [ ] Test IDs `stats-shot-count`, `stats-total-length`, `stats-depth-range` on values
- [ ] aria-label on stats container with descriptive text
- [ ] TypeScript types pass (pnpm tsc --noEmit)
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
