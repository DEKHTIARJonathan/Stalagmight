# fn-19-mmx.6 Update frontend to fit-to-bounds after datum set

## Description
Update frontend to call `triggerFitToBounds()` after setting zero datum so the map view shows the repositioned content.

**Size:** S
**Files:** `src/store/projectStore.ts`, `src/App.tsx`

## Approach

1. In `setZeroDatum` action (projectStore.ts:683-689), after successful result, call `triggerFitToBounds()`
2. Or handle in App.tsx where import placement already calls `triggerFitToBounds()`
3. Ensure fit-to-bounds respects any padding/margin settings

Follow existing pattern from import placement at `App.tsx:236-244`.

## Key context

`triggerFitToBounds()` is in `useUIStore`. It triggers the map to zoom/pan to fit all visible content. After datum repositioning, sections may have moved significantly.
## Acceptance
- [ ] Map fits to bounds after successful datum set
- [ ] Fit-to-bounds called only on success (not on error)
- [ ] Works for both setting new datum and modifying existing
- [ ] TypeScript types pass (pnpm tsc --noEmit)
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
