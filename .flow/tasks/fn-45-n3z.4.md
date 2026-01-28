# fn-45-n3z.4 Add Loop Closures section to DetailPanel

## Description

Add "Loop Closures" section to DetailPanel showing direct and transitive closure relationships. Include collapsible UI, grouped display with metrics, and navigation via DetailLink. Update SPEC.md documentation.

**Size:** M
**Files:**
- `src/components/SingleSystemView/DetailPanel.tsx` (closure display)
- `docs/SPEC.md` (documentation)
- `e2e-playwright/` (E2E tests)

## Approach

1. Add "Loop Closures" section in `DetailPanel.tsx` after merged stations (line 403):
   - Section placement: after "Merged with", before action buttons
   - Use collapsible pattern (useState with boolean, default expanded)
   - Hide section entirely when `station.closures_with.length === 0`

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

- Follow merged_with display pattern at `DetailPanel.tsx:383-403`
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
TBD

## Evidence
- Commits:
- Tests:
- PRs:
