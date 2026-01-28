# fn-45-n3z.4 Add Loop Closures section to DetailPanel

## Description

Add "Loop Closures" section to DetailPanel showing direct and transitive closure relationships. Include collapsible UI, grouped display with metrics, and navigation via DetailLink. Update SPEC.md documentation.

**Size:** M
**Files:**
- `src/components/SingleSystemView/DetailPanel.tsx` (closure display)
- `docs/SPEC.md` (documentation)
- `e2e-playwright/` (E2E tests)

## Approach

<!-- Updated by plan-sync: fn-45-n3z.1 confirmed line references and TypeScript types -->
1. Add "Loop Closures" section in `DetailPanel.tsx` after merged stations (line 403):
   - Section placement: after "Merged with" (lines 383-403), before "Connected" section (line 405)
   - Use collapsible pattern (useState with boolean, default expanded)
   - Hide section entirely when `!station.closures_with?.length` (field is optional in TypeScript: `closures_with?: ClosureRef[]`)

2. Display format:
   - Group closures by `closure_id` (all stations with same closure_id grouped together)
   - Direct closures: "Closure to B, C, D" (comma-separated station links)
   - Transitive closures: "Transitive closure to X, Y (via A)" with `text-text-tertiary` class
   - Metrics below each group: "Path: 15.2m | Error: 0.30m (1.97%)"
   - Order: direct closures first, then transitive

3. Navigation:
   - Use `DetailLink` component for each station (pattern at lines 383-403)
   - onClick → navigate to target station (same as merged station behavior)
   - Props: type="station", target, displayText, onSelect

4. Metrics lookup:
   - Get full closure data from `project.loop_closures` by `closure_id`
   - Format: path_length.toFixed(1), misclosure_distance.toFixed(2), error_percentage.toFixed(2)

5. Update `docs/SPEC.md`:
   - Section 4.1: Add closures_with to Station data model
   - Section 6.2.1: Document Loop Closures section in Detail Panel
   - Section 7.5: Update merge validation flow

6. Add E2E tests:
   - Create closure → verify appears in station details
   - Verify closure navigation works
   - Verify merge-to-closure redirect shows reason

## Key Context

- Follow merged_with display pattern at `DetailPanel.tsx:383-403` (uses `DetailLink` with `handleSelectMergedStation`, `mergedStationExists`, `formatStationId`)
- DetailLink component at `src/components/common/DetailLink.tsx`
- formatStationId helper for display text
- Collapsible pattern: useState boolean, conditional rendering
## Acceptance
- [ ] "Loop Closures" section appears after "Merged with" in DetailPanel
- [ ] Section is collapsible (default expanded)
- [ ] Section hidden when station has no closures
- [ ] Direct closures displayed with grouped station links
- [ ] Transitive closures have "(via X)" and muted text styling
- [ ] Metrics displayed below each group: "Path: X | Error: Y (Z%)"
- [ ] DetailLink navigation works for closure targets
- [ ] Direct closures sorted before transitive closures
- [ ] SPEC.md updated with data model, UI, and validation changes
- [ ] E2E: closure appears in station details with metrics
- [ ] E2E: closure navigation works
- [ ] E2E: merge-to-closure redirect shows reason subtitle
- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm test:ui` passes
## Done summary
Added Loop Closures collapsible section to StationDetail in DetailPanel.tsx. Groups closures by closure_id (direct first, then transitive). Direct: 'Closure to B, C' with DetailLink. Transitive: 'Transitive closure to X (via A)' with muted text. Metrics per group from project.loop_closures. Hidden when empty. Updated SPEC.md (4.1 data model, 6.2.1 UI, 7.5 workflow). 6 E2E tests pass. tsc --noEmit passes.
## Evidence
- Commits: 75b3f4b, b3a2a29
- Tests: pnpm tsc --noEmit: pass, pnpm test:ui closure tests: 13/13 pass
- PRs: