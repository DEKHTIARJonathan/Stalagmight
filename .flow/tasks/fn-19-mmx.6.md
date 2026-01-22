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
- [x] Map fits to bounds after successful datum set
- [x] Fit-to-bounds called only on success (not on error)
- [x] Works for both setting new datum and modifying existing
- [x] TypeScript types pass (pnpm tsc --noEmit)
## Done summary
Added triggerFitToBounds() call after successful setZeroDatum in projectStore.ts:688 with optional fitToBounds parameter (defaults to true). Import flow in App.tsx passes fitToBounds: false to avoid redundant fits during batch operations - import already does a single fit at the end.
## Evidence
- Commits: 9657906 feat(ui): trigger fit-to-bounds after setting zero datum
- Tests: TypeScript passes (pnpm tsc --noEmit), Playwright tests pass (464/464), Rust tests pass (678 + 80 integration)
- Review: Codex impl-review SHIP
- PRs: