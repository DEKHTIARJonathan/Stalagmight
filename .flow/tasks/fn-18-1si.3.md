# fn-18-1si.3 Add section stats to DmpSectionConfigDialog

## Description
Add current section statistics display at the top of the Parameters panel in DmpSectionConfigDialog.

**Size:** M
**Files:** `src/components/Dialogs/DmpSectionConfigDialog.tsx`

## Approach

1. Import `useProjectStore` for config access
2. Import formatting utilities from `src/utils/formatStats.ts`
3. Create useMemo for section stats calculation:
   - Filter `currentConfig.shots` to exclude deleted shots (`!s.isDeleted`)
   - **Note**: currentConfig.shots already contains only Standard shots (filtered during import config creation)
   - **Exclude negative lengths from total** (data corruption guard)
   - **Use `Number.isFinite()` for depth values** (exclude NaN/Infinity)
   - Sum lengths, count shots
   - Calculate depth range from depth_in/depth_out
4. Add stats display inside Parameters panel (line ~1131), before SectionMetadataForm
5. Add "Depth: " prefix when rendering (formatDepthRange returns just the range)
6. Apply gray-out styling when `isCurrentExcluded` is true

## Key context

**Important**: In Step 2, `currentConfig.shots` comes from `useImportState` which already filters to Standard shots during initialization. The filtering happens in the hook, not in the dialog. So we only need to filter out deleted shots.

Stats calculation for Step 2:
```typescript
const visibleShots = currentConfig.shots.filter((s) => !s.isDeleted);
// visibleShots are already Standard-type only
```

Stats format: `{shots} shots | {length} | Depth: {range}`
With subtle `border-b border-border pb-3 mb-3` separator

## Acceptance
- [ ] Stats displayed at top of Parameters panel (before SectionMetadataForm)
- [ ] Stats reflect current shot table state (edited values, deletions counted)
- [ ] Shows "0 shots | 0.0m | Depth: --" when all shots deleted
- [ ] Excludes negative length values from total
- [ ] Excludes non-finite depth values (NaN, Infinity) from range calculation
- [ ] Depth range from min/max of depth_in/depth_out of visible shots
- [ ] Unit conversion applied based on config.units.length and config.units.depth
- [ ] Subtle separator line (border-bottom) between stats and form fields
- [ ] Stats grayed out (reduced opacity) when section is excluded
- [ ] Uses pipe separators with "Depth: " prefix: `shots | length | Depth: range`
- [ ] Test ID `section-stats` on container
- [ ] Test IDs `section-stats-shot-count`, `section-stats-total-length`, `section-stats-depth-range`
- [ ] aria-label on stats container with descriptive text
- [ ] TypeScript types pass (pnpm tsc --noEmit)
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
