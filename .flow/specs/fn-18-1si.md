# Import Dialog Statistics Footer

## Overview

Add aggregate statistics (shot count, total length, depth range) to DMP import dialogs:
- **Step 1 (DmpSelectionDialog)**: Selection-based stats in metadata header, updating real-time
- **Step 2 (DmpSectionConfigDialog)**: Current section stats at top of Parameters panel

## Scope

**In scope:**
- Stats calculation with unit conversion (meters/feet from config)
- Real-time updates on selection/edit changes
- Accessibility (aria-label on containers)
- Test IDs for Playwright

**Out of scope:**
- Debouncing (not needed for discrete checkbox/edit actions)
- Stats for aggregate of all importing sections in Step 2

## Quick commands

```bash
# Type check
pnpm tsc --noEmit

# Run import dialog tests
pnpm test:ui -- --grep "DMP"

# Dev server
./scripts/dev.sh
```

## Approach

### Stats Formatting Utility

Create `src/utils/formatStats.ts` with:
- `formatLength(meters, unit, precision)` - converts and formats length
- `formatDepthRange(min, max, unit, precision)` - formats depth range with "--" fallback
- Reuse existing pattern from `export-colors.ts:295` (`formatDepth`)

### Step 1 Changes (DmpSelectionDialog)

Modify `calculateMetadata` (line 35-68) to:
- Accept `selectedIndices` parameter for filtering
- Add depth range calculation (min/max of depth_in/depth_out)
- Access config via `useProjectStore` for unit conversion

Update metadata header (lines 219-237) to show selection-based stats.

### Step 2 Changes (DmpSectionConfigDialog)

Add stats display inside Parameters panel (before SectionMetadataForm):
- Calculate from `currentConfig.shots.filter(s => !s.isDeleted)`
- Show at top of panel with separator line below
- Gray out when section is excluded

### Key Files

| File | Changes |
|------|---------|
| `src/utils/formatStats.ts` | New - formatting utilities |
| `src/components/Dialogs/DmpSelectionDialog.tsx` | Modify calculateMetadata, update header |
| `src/components/Dialogs/DmpSectionConfigDialog.tsx` | Add stats to Parameters panel |
| `docs/SPEC.md` | Update dialog mockups |
| `docs/TESTING.md` | Add test ID documentation |

### Existing Patterns to Follow

- Stats calculation: `DmpImportDialog.tsx:69-98` (`calculateStats`)
- Stats UI: `DmpImportDialog.tsx:976-992` (footer format)
- Unit formatting: `export-colors.ts:295` (`formatDepth`)
- Config fallback: `DmpImportDialog.tsx:259` (defaultConfig pattern)

## Edge Cases

- Depth 0.0: Valid measurement (water level), include in range
- Non-finite depths: Use `Number.isFinite()` check, exclude if invalid
- All non-Standard shots: Show "0 shots | 0.0m | Depth: --"
- Config not loaded: Fall back to `defaultConfig.units`
- Negative lengths: Exclude from total (data corruption)
- Negative depths: Include (valid above-water measurement)

## Risks

| Risk | Mitigation |
|------|------------|
| Config access adds dependency | Follow existing pattern from DmpImportDialog |
| formatDepth in export-colors.ts is export-specific | Create generic utility in formatStats.ts |
| Large DMP files could slow stats | Profile if needed; naive loop is O(n) |

## Test Notes

- Step 1: Verify stats update when toggling checkboxes
- Step 2: Verify stats update when editing/deleting shots
- Verify unit conversion with config.units.length = 'feet'
- Verify "Depth: --" when no depth data
- Test aria-label contains descriptive text

## Acceptance

- [ ] Step 1 metadata header shows selection-based stats (shots | length | depth range)
- [ ] Step 1 stats update in real-time when sections are checked/unchecked
- [ ] Step 1 shows zeros when no sections selected
- [ ] Step 2 Parameters panel shows current section stats at top
- [ ] Step 2 stats reflect current shot table state (edited values, deletions)
- [ ] Step 2 stats have subtle separator line below them
- [ ] Step 2 excluded sections show grayed-out stats
- [ ] Depth range calculated from min/max of depth_in/depth_out
- [ ] No depth data shows "Depth: --"
- [ ] Units read from project config (length and depth independently)
- [ ] Values converted to feet when config is set to feet
- [ ] Unit suffix shows 'm' or 'ft' appropriately
- [ ] 1 decimal place precision for length and depth
- [ ] Pipe separators between stats
- [ ] aria-label on stats containers
- [ ] Test IDs present on all stat elements
- [ ] TypeScript types pass (pnpm tsc --noEmit)
- [ ] Playwright tests pass (pnpm test:ui)

## References

- Epic spec: `.flow/specs/fn-18-1si.md`
- DmpImportDialog stats pattern: `src/components/Dialogs/DmpImportDialog.tsx:69-98, 976-992`
- Unit config types: `src/types/config.ts:39-44`
- formatDepth utility: `src/utils/export-colors.ts:295`
