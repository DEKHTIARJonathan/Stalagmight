# fn-38-4ja.2 Add Playwright E2E test for section zoom margin

## Description

Add a Playwright E2E test that verifies section zoom leaves visible margin from viewport edges and the zoom level is within a reasonable range. Tests both the double-click trigger and the center button trigger.

**Size:** S
**Files:**
- `e2e-playwright/section-zoom-margin.spec.ts` (new test file)

## Approach

### Test structure

Create `e2e-playwright/section-zoom-margin.spec.ts` with tests for:

1. **Section zoom has margin from viewport edges**
   - Seed a project with a multi-station section using `seedProjectWithSections`
   - Pan the map off-target first (memory pitfall: avoid false passes from pre-centered state)
   - Double-click a section row to trigger `triggerZoomToSection`
   - Wait for map idle (`waitForMapIdle`)
   - Use `page.evaluate()` to project all section station coords to screen pixels via `map.project()`
   - Assert that all projected points have ≥5% margin from viewport edges (allowing some tolerance from the 10% target)
   - Assert zoom level is ≤ `zoom_max` (22)

2. **Center button produces same zoom behavior**
   - Same setup as above
   - Click the center button (`data-testid="center-section-button"`) instead of double-clicking
   - Same margin and zoom assertions

3. **Skip zoom-in when section already visible** (optional, if feasible)
   - Zoom to section first, then trigger zoom-to-section again
   - Assert zoom level did not change (only centering occurred)
   - Verify section is still within viewport with margin (the easeTo center path includes padding)

### Test patterns to follow

- Follow patterns from `e2e-playwright/zoom-tool.spec.ts` and `e2e-playwright/section-dropdown-hover.spec.ts`
- Access map via `window.__cavechef_map__` in `page.evaluate()`
- Use `expect.poll()` for state change assertions
- Use `waitForMapReady` and `waitForMapIdle` helpers from `e2e-playwright/helpers/app.ts`
- Use `seedProjectWithSections` to create deterministic test data

## Key context

- **Pan off-target before zoom trigger** — Memory pitfall: tests may pass falsely if map is already centered on the target section. Always pan away first.
- **Playwright map init** — Must `waitForFunction('__cavechef_map__')` after canvas appears (memory pitfall).
- **`map.project()` returns `{x, y}`** — x/y are pixel offsets from top-left of the map container.
- **Container dimensions** — Get via `map.getContainer().clientWidth` / `clientHeight` in `page.evaluate()`.
- **easeTo center path includes padding** — The skip-zoom-in path passes the full padding object to `easeTo`, so section should be centered within usable viewport area even with panels open.

## Acceptance
- [ ] Playwright test file exists at `e2e-playwright/section-zoom-margin.spec.ts`
- [ ] Test verifies section station screen positions have ≥5% margin from all viewport edges after zoom
- [ ] Test verifies zoom level is ≤ zoom_max (22) after section zoom
- [ ] Test covers double-click trigger (sections panel row)
- [ ] Test covers center button trigger (detail panel header)
- [ ] Map is panned off-target before each zoom trigger to avoid false passes
- [ ] `pnpm test:ui` passes (all Playwright tests including new ones)

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
