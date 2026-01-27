# fn-35-v6w.2 Add E2E tests for MapLibre control styling

## Description

Add E2E tests verifying that MapLibre control dark theme CSS is correctly applied in both MapCanvas and GlobalViewMap.

**Size:** S
**Files:** `e2e/specs/map-controls-styling.spec.ts`

## Approach

Follow existing CSS assertion patterns:
- `section-highlighting-a11y.spec.ts:301-304` — `browser.execute(getComputedStyle)` for backgroundColor
- `shortcuts-accessibility.spec.ts:766-772` — multi-property style collection
- `export-accessibility.spec.ts:388-397` — focus indicator verification

### Test Cases

**MapCanvas view:**
1. Navigate to a project with map data
2. Wait for map ready (`__cavechef_map__`)
3. Assert `.maplibregl-ctrl-group` background-color is `rgb(22, 33, 62)` (#16213e)
4. Assert `.maplibregl-ctrl-group button + button` border-top-color is `rgb(15, 52, 96)` (#0f3460)
5. Assert `.maplibregl-ctrl-icon` filter includes `invert`

**GlobalViewMap:**
1. Navigate to global view
2. Wait for map ready
3. Assert `.maplibregl-ctrl-group` background-color matches
4. Assert `.maplibregl-ctrl-scale` has transparent/no background, border-color `rgb(15, 52, 96)`, color `rgb(245, 245, 245)`

**Scale bar toggle (MapCanvas):**
1. Toggle scale bar on via Display menu
2. Assert `.maplibregl-ctrl-scale` has correct colors
3. Toggle off, verify element removed

### Key context

- WebdriverIO tests use `browser.execute(() => window.getComputedStyle(el).property)` pattern
- Must wait for `__cavechef_map__` global before asserting map control styles (see memory pitfall)
- Colors in getComputedStyle return RGB format, not hex
- Use `$('.maplibregl-ctrl-group')` WebdriverIO selector for MapLibre controls
## Acceptance
- [ ] New test file `e2e/specs/map-controls-styling.spec.ts` created
- [ ] Test verifies `.maplibregl-ctrl-group` background-color in MapCanvas
- [ ] Test verifies `.maplibregl-ctrl-group` button divider border color
- [ ] Test verifies `.maplibregl-ctrl-icon` has filter applied (inverted for dark bg)
- [ ] Test verifies `.maplibregl-ctrl-scale` colors in GlobalViewMap (transparent bg, themed border/text)
- [ ] Test verifies scale bar toggle in MapCanvas applies correct styles on re-add
- [ ] Tests use `browser.execute(getComputedStyle)` pattern consistent with existing tests
- [ ] Tests wait for `__cavechef_map__` before style assertions
- [ ] All existing E2E tests continue to pass (`pnpm test:ui`)
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
