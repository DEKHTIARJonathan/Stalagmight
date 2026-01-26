# fn-22-lf7.4 Add E2E tests for link hover highlighting

## Description

Add Playwright E2E tests verifying that hovering/focusing DetailLink elements in the DetailPanel highlights the corresponding elements on the map.

**Size:** M
**Files:** `e2e-playwright/detail-link-hover.spec.ts` (new file)

## Approach

1. Create new spec file following existing Playwright patterns in `e2e-playwright/`
2. Test station link hover:
   - Select a station to show its detail panel
   - Hover a "Previous Shot" or merged station link
   - Verify map shows hover state (check feature-state or visual indicator)
3. Test shot link hover:
   - Similar flow with shot links
4. Test section link hover:
   - Hover section link, verify all section elements highlight
5. Test keyboard focus:
   - Tab to a link, verify highlight appears
   - Tab away, verify highlight clears
6. Test coexistence:
   - Verify table row hover still works
   - Verify map hover still works

## Key Context

- Use `page.hover('[data-testid="station-X-Y-link"]')` for hover triggers
- Use `page.focus('[data-testid="..."]')` for keyboard focus
- Map hover state uses feature-state which may be harder to test visually
- Consider testing via uiStore state changes instead of visual assertions
- Follow patterns in existing E2E tests (see `e2e-playwright/*.spec.ts`)
## Acceptance
- [ ] Test file created at `e2e-playwright/detail-link-hover.spec.ts`
- [ ] Test: hovering station link highlights station on map
- [ ] Test: hovering shot link highlights shot on map
- [ ] Test: hovering section link highlights section elements on map
- [ ] Test: tab-focusing link triggers highlight
- [ ] Test: tabbing away clears highlight
- [ ] Test: mouse leave clears highlight
- [ ] Test: existing table row hover still works
- [ ] All tests pass with `pnpm test:ui`
## Done summary
Implemented comprehensive E2E tests for DetailLink hover/focus highlighting that verify hovering station/shot/section links highlights corresponding map elements via uiStore state changes. Tests cover hover, mouse leave, focus, blur, keyboard navigation, and coexistence with existing section row and map hover behaviors.
## Evidence
- Commits: dac04c97add2c67cb7be77ca9d9a4aecd347b260
- Tests: pnpm test:ui -- detail-link-hover.spec.ts (24 passed), pnpm test:ui (521 passed)
- PRs: