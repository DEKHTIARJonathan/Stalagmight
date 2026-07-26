import { test, expect, Page } from './fixtures/coverage';
import { setupTauriMocks } from './mocks/tauri-ipc';
import {
  seedProjectWithSections,
  waitForDrawnStations,
  getStationScreenPositions,
  readCanvasPixel,
  readCanvasPixelBlock,
  type PixelRgba,
  type SectionSeed,
} from './helpers/app';
import { GAS_NEAR } from '../src/utils/gasReach';

/**
 * E2E for the gas reachable-frontier overlay, now the Plan workspace mode (#38,
 * the workspace-mode reframe). Plan is entered from the top-middle Survey/Plan/Export carousel
 * (not the old toolbar toggle); it forces the read-only closure map, swaps the right
 * Dock for the gas setup sidebar, and the bottom Dock for the tabbed plan tables.
 *
 * The survey is drawn by the custom WebGL renderer, so the old overlay oracle is
 * gone: there is no `survey-stations` layer whose `circle-color` paint could be
 * checked for a `gasReach` feature-state interpolate, and no
 * `survey-data-stations` vector-tile source to read that feature-state from. The
 * renderer resolves the SAME ramp color per feature at build time
 * (surveyLayer/customRender/overlayColor.ts, byte-identical to the old
 * data-driven paint), so the oracle here is the PAINTED STATION PIXEL: "a station
 * carries a numeric gasReach >= 0" becomes "a station is painted a reachable
 * gold->purple ramp color, while the over-budget ones are painted grey".
 * `survey-gas-route` is still a stock layer, so its assertions are unchanged.
 * The IPC field is mocked (`compute_gas_reach_field`).
 */

async function createProject(page: Page, name: string): Promise<void> {
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill(name);
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });
}

// A single section long enough that the mock's fixed budget (1500 L) leaves the
// far stations out of range - so the overlay has both reachable (gold→purple) and
// unreachable (grey) stations and a non-empty turn frontier.
const sectionSeeds: SectionSeed[] = [
  {
    name: 'Gas A',
    direction: 'in',
    // Positive depths (z = depth, positive below surface - the real convention), so the route
    // depth readouts show physically-sensible values a regression would visibly break.
    shots: Array.from({ length: 10 }, (_, i) => ({
      azimuth_in: 90,
      azimuth_out: 270,
      length: 10,
      depth_in: i,
      depth_out: i + 1,
    })),
  },
];

/**
 * Station indices the pixel probes use, from the mock's synthetic field: it puts
 * station `i` at `x = i * 10` and charges `|x| * 20` litres against a fixed
 * 1500 L budget, so stations 0..7 are reachable (7 -> 1400 L, the last one inside
 * the budget) and 8..10 are over budget and render grey.
 */
const LAST_REACHABLE = 7;
const OVER_BUDGET = 10;

/**
 * Zoom bump for the pixel probes. +3 spreads the 11 stations to ~37 px apart (so a
 * 9 px footprint block is one station's) while keeping the whole 100 m survey on
 * the canvas; +4 pushes the far stations off-screen.
 */
const PROBE_ZOOM_DELTA = 3;

async function waitForMapLoaded(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const map = (window as unknown as { __stalagmight_map__?: { loaded: () => boolean } })
            .__stalagmight_map__;
          return map?.loaded() ?? false;
        }),
      { timeout: 10000 },
    )
    .toBe(true);
}

type StationRefLite = { section_id: number; station_index: number };

type E2EWindow = {
  __E2E_TEST__?: {
    uiStore: {
      getState: () => { appMode: string; activeTool: string; setActiveTool: (t: string) => void };
    };
    gasPlanStore: {
      getState: () => {
        origin: StationRefLite | null;
        endpoint: StationRefLite | null;
        waypoints: StationRefLite[];
        markedPoints: { station: StationRefLite; label: string | null }[];
        reachField: { turn_frontier: StationRefLite[] } | null;
      };
    };
  };
};

/**
 * A Plan context-menu entry, addressed by ROLE. The menu rows are buttons, and matching them by
 * text alone collides with prose that quotes the same label (the Origin hint names "Set as start
 * point" so the user can find it).
 */
function planMenuItem(page: Page, label: string) {
  return page.getByRole('button', { name: label, exact: true });
}

/** The gas plan's ordered way points (#298). */
async function gasWaypoints(page: Page): Promise<StationRefLite[]> {
  return page.evaluate(
    () => (window as unknown as E2EWindow).__E2E_TEST__?.gasPlanStore.getState().waypoints ?? [],
  );
}

async function appMode(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as E2EWindow).__E2E_TEST__?.uiStore.getState().appMode ?? '');
}

/** The gas plan's chosen route endpoint (null if unset). Shared so the endpoint-pick
 *  specs don't each re-spell the `__E2E_TEST__.gasPlanStore` cast. `?? null` keeps a
 *  `.not.toBeNull()` assertion honest - a missing hook reads null, not undefined. */
async function gasEndpoint(page: Page): Promise<StationRefLite | null> {
  return page.evaluate(
    () => (window as unknown as E2EWindow).__E2E_TEST__?.gasPlanStore.getState().endpoint ?? null,
  );
}

/** The reachable turn-frontier refs, in the order the map markers are built from. */
async function turnFrontier(page: Page): Promise<StationRefLite[]> {
  return page.evaluate(
    () =>
      (window as unknown as E2EWindow).__E2E_TEST__?.gasPlanStore.getState().reachField
        ?.turn_frontier ?? [],
  );
}

async function activeTool(page: Page): Promise<string> {
  return page.evaluate(
    () => (window as unknown as E2EWindow).__E2E_TEST__?.uiStore.getState().activeTool ?? '',
  );
}

/** `#rrggbb` -> the `r,g,b,a` key the renderer packs it to (opaque). */
function colorKey(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},255`;
}

/** The near (gold) end of the reachable ramp: a station at gas cost 0 is painted
 *  exactly this (MapLibre's `interpolate` short-circuits the 0 stop, and
 *  `packRampColor` reproduces that). */
const GAS_NEAR_KEY = colorKey(GAS_NEAR);

/** The theme's gray line, which both the stock ramp and the custom resolver use
 *  for "unreachable on this gas plan". Read from the live theme so a theme change
 *  can't silently turn this into a stale literal. */
async function greyKey(page: Page): Promise<string> {
  return colorKey(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--cc-gray-line').trim(),
    ),
  );
}

/** Absolute map zoom, so probes can be pinned to one calibrated view. */
async function mapZoom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const map = (window as unknown as { __stalagmight_map__?: { getZoom: () => number } })
      .__stalagmight_map__;
    return map?.getZoom() ?? 0;
  });
}

/**
 * Jump the map to an absolute zoom (no animation). Probing painted pixels needs a
 * zoomed-in view: at the fit-to-bounds zoom the seeded survey is only a few screen
 * px wide and every station disc overlaps its neighbours. Absolute (not `+= delta`)
 * so re-pinning after a mode switch or a rebuild can never compound and push the
 * far stations off the canvas.
 */
async function setMapZoom(page: Page, zoom: number): Promise<void> {
  await page.evaluate((z) => {
    const map = (window as unknown as { __stalagmight_map__?: { setZoom: (z: number) => void } })
      .__stalagmight_map__;
    map?.setZoom(z);
  }, zoom);
}

async function stationAt(page: Page, stationIndex: number): Promise<{ x: number; y: number }> {
  const stations = await getStationScreenPositions(page);
  const station = stations.find((s) => s.stationIndex === stationIndex);
  if (!station) throw new Error(`no drawn station ${stationIndex}`);
  return station;
}

/**
 * The 9x9 CSS-px block painted around one station, as a raw RGBA array.
 *
 * A block rather than the single center pixel because Plan draws the gas ROUTE
 * line over the survey, and it covers the center of every station it passes
 * through; the station's own overlay fill has to be read from the rest of its
 * disc. Station spacing at the calibrated zoom is ~37 px, so a 9 px block never
 * reaches a neighbour.
 */
async function stationBlock(page: Page, stationIndex: number): Promise<number[]> {
  const { x, y } = await stationAt(page, stationIndex);
  return readCanvasPixelBlock(page, x, y, 9);
}

/** The distinct `r,g,b,a` colors painted inside a station's footprint. */
async function stationColors(page: Page, stationIndex: number): Promise<Set<string>> {
  const buf = await stationBlock(page, stationIndex);
  const out = new Set<string>();
  for (let i = 0; i < buf.length; i += 4) {
    out.add(`${buf[i]},${buf[i + 1]},${buf[i + 2]},${buf[i + 3]}`);
  }
  return out;
}

async function stationPaints(page: Page, stationIndex: number, color: string): Promise<boolean> {
  return (await stationColors(page, stationIndex)).has(color);
}

/** The station's own fill in Survey mode, where nothing is drawn over it. */
async function stationCenter(page: Page, stationIndex: number): Promise<PixelRgba> {
  const { x, y } = await stationAt(page, stationIndex);
  return readCanvasPixel(page, x, y);
}

async function enterMode(page: Page, mode: 'survey' | 'plan' | 'export'): Promise<void> {
  await page.locator(`[data-testid="mode-${mode}"]`).click();
}

/** Enter Plan, add a stage, select + acknowledge the 1-stage strategy → one ▼ drop marker + route. */
async function setupOneStageDrop(page: Page): Promise<void> {
  await enterMode(page, 'plan');
  await expect(page.locator('[data-testid="cylinders-table"]')).toBeVisible({ timeout: 3000 });
  await page.selectOption('[data-testid="gas-add-tank"]', 'al80');
  await page.locator('[data-testid="gas-cylinder-role"]').last().selectOption('stage');
  const oneStage = page.locator('[data-testid="gas-reserve-one_stage"]');
  await expect(oneStage).toBeEnabled();
  await oneStage.click();
  await page.locator('[data-testid="gas-pushy-ack-confirm"]').click();
  await expect
    .poll(() => page.locator('[data-testid="gas-drop-marker"]').count(), { timeout: 3000 })
    .toBeGreaterThan(0);
}

/** The store's per-stage drop overrides (#246). */
async function stageDropOverrides(page: Page): Promise<Array<StationRefLite | null>> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __E2E_TEST__?: {
            gasPlanStore: {
              getState: () => { stageDropOverrides: Array<StationRefLite | null> };
            };
          };
        }
      ).__E2E_TEST__?.gasPlanStore.getState().stageDropOverrides ?? [],
  );
}

/** The `stage_drop_overrides` argument the LAST compute_gas_reach_field call was invoked with. */
async function lastGasReachOverrides(page: Page): Promise<Array<StationRefLite | null>> {
  return page.evaluate(() => {
    const calls =
      (
        window as unknown as {
          __MOCK_GAS_REACH_CALLS__?: Array<{ stageDropOverrides: Array<StationRefLite | null> }>;
        }
      ).__MOCK_GAS_REACH_CALLS__ ?? [];
    return calls.length ? calls[calls.length - 1].stageDropOverrides : [];
  });
}

test.describe('Gas planning', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await createProject(page, 'Gas Planning Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapLoaded(page);
  });

  test('Plan mode shows the gas overlay (panel + painted ramp + legend); back to Survey resets @smoke', async ({
    page,
  }) => {
    expect(await appMode(page)).toBe('survey');
    await expect(page.locator('[data-testid="gas-panel"]')).toHaveCount(0);

    // Calibrate one absolute zoom for every probe in this test, and capture the
    // baseline: in Survey the stations are painted their section color and no part
    // of the gas ramp is on screen.
    await waitForDrawnStations(page, 1);
    const zoom = (await mapZoom(page)) + PROBE_ZOOM_DELTA;
    await setMapZoom(page, zoom);
    const grey = await greyKey(page);
    const sectionKey = (await stationCenter(page, LAST_REACHABLE)).join(',');
    expect(await stationPaints(page, LAST_REACHABLE, sectionKey)).toBe(true);
    expect(await stationPaints(page, 0, GAS_NEAR_KEY)).toBe(false);
    expect(await stationPaints(page, OVER_BUDGET, grey)).toBe(false);

    await enterMode(page, 'plan');
    expect(await appMode(page)).toBe('plan');

    // The setup sidebar replaces the detail panel in the right Dock slot.
    await expect(page.locator('[data-testid="gas-panel"]')).toBeVisible({ timeout: 3000 });
    // Legend appears with the entrance origin.
    await expect(page.locator('[data-testid="gas-legend"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="gas-legend-origin"]')).toContainText('entrance');
    // The symbol key explains the markers (turn/end point always present in Plan).
    await expect(page.locator('[data-testid="gas-legend-key"]')).toContainText('Turn / end point');

    // The reachable ramp is populated, not an all-grey field: the origin station sits
    // at gas cost 0, the exact gold near end of the ramp. Polled (the field is
    // fetched over IPC, and entering Plan can re-fit the view) with the zoom
    // re-pinned first so the probe reads the calibrated view.
    await setMapZoom(page, zoom);
    await expect.poll(() => stationPaints(page, 0, GAS_NEAR_KEY), { timeout: 3000 }).toBe(true);

    // The last station inside the budget is painted an INTERIOR ramp color: not the
    // near end, not the unreachable grey, and no longer its section color.
    const lastReachable = await stationColors(page, LAST_REACHABLE);
    expect(lastReachable.has(sectionKey)).toBe(false);
    expect(lastReachable.has(GAS_NEAR_KEY)).toBe(false);
    expect(lastReachable.has(grey)).toBe(false);
    // ...and the over-budget station goes grey (the conservative direction).
    const overBudget = await stationColors(page, OVER_BUDGET);
    expect(overBudget.has(grey)).toBe(true);
    expect(overBudget.has(sectionKey)).toBe(false);

    // Back to Survey → panel + legend gone, section colors restored (the overlay is
    // appMode-gated; the gas store itself persists across mode switches, #244).
    await enterMode(page, 'survey');
    expect(await appMode(page)).toBe('survey');
    await expect(page.locator('[data-testid="gas-panel"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="gas-legend"]')).not.toBeVisible();
    await setMapZoom(page, zoom);
    await expect
      .poll(() => stationPaints(page, LAST_REACHABLE, sectionKey), { timeout: 3000 })
      .toBe(true);
    expect(await stationPaints(page, 0, GAS_NEAR_KEY)).toBe(false);
    expect(await stationPaints(page, OVER_BUDGET, grey)).toBe(false);
  });

  test('Plan gates the staged reserve presets to a stage-carrying rig; readout reads as gas @smoke', async ({
    page,
  }) => {
    await enterMode(page, 'plan');
    expect(await appMode(page)).toBe('plan');
    await expect(page.locator('[data-testid="gas-panel"]')).toBeVisible({ timeout: 3000 });

    // Swim speed input is present, populated with the 10 m/min default (#236).
    await expect(page.locator('[data-testid="gas-panel"]')).toContainText('Swim speed');
    const swim = page.locator('[data-testid="gas-swim-speed-input"]');
    await expect(swim).toBeVisible();
    await expect(swim).toHaveValue(/^10(\.0)?$/);

    // Default rig is twin-AL80 back gas (ZERO stages) → the pushy presets are greyed (the
    // advanced gate); All-thirds stays available.
    await expect(page.locator('[data-testid="gas-reserve-all_thirds"]')).toBeEnabled();
    await expect(page.locator('[data-testid="gas-reserve-one_stage"]')).toBeDisabled();
    await expect(page.locator('[data-testid="gas-reserve-two_stage"]')).toBeDisabled();

    // The "max" readout is labelled as a gas volume, not a penetration distance.
    await expect(page.locator('[data-testid="gas-readout-max"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="gas-panel"]')).toContainText('Gas to farthest point');
    // The strategy is "Gas strategy" with the back-gas turn-pressure gauge (All-thirds default).
    await expect(page.locator('[data-testid="gas-panel"]')).toContainText('Gas strategy');
    await expect(page.locator('[data-testid="gas-panel"]')).toContainText('Backgas turn pressure');
    await expect(page.locator('[data-testid="gas-readout-backgas-turn"]')).toBeVisible();
  });

  test('Plan readout shows the route distance + max/avg depth once a route resolves @smoke', async ({
    page,
  }) => {
    await enterMode(page, 'plan');
    expect(await appMode(page)).toBe('plan');
    // Entering Plan resolves a route to the deepest reachable station, so the distance + depth
    // rows appear, formatted with a length unit (#236). Values come straight from the backend.
    const distance = page.locator('[data-testid="gas-readout-route-distance"]');
    await expect(distance).toBeVisible({ timeout: 3000 });
    await expect(distance).toContainText('m');
    await expect(page.locator('[data-testid="gas-panel"]')).toContainText('Distance to turnaround');
    // The Max / Average depth rows render once a route is known. This asserts the WIRING only: the
    // e2e mock's get_project_state hardcodes station z = 0 (it doesn't derive depth from shot data),
    // so these readouts show "0.0 m" here regardless of the seed - there's no meaningful depth value
    // to assert at the mock level. The exact distance/depth math (tie-exclusion, deepest-point, sign)
    // is pinned in the Rust unit tests (gas/tests.rs).
    await expect(page.locator('[data-testid="gas-readout-max-depth"]')).toBeVisible();
    await expect(page.locator('[data-testid="gas-readout-avg-depth"]')).toBeVisible();
  });

  test('Plan swim speed persists to the saved config @smoke', async ({ page }) => {
    await enterMode(page, 'plan');
    const swim = page.locator('[data-testid="gas-swim-speed-input"]');
    await expect(swim).toBeVisible({ timeout: 3000 });
    // Editing swim speed writes back to the saved config (#236) - unlike the panel's other
    // per-session inputs - so it sticks across Plan exit / restart and stays in sync with Settings.
    await swim.fill('14');
    await swim.blur();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __E2E_TEST__: {
                  projectStore: {
                    getState: () => { config: { gas: { swim_speed_m_per_min: number } } | null };
                  };
                };
              }
            ).__E2E_TEST__.projectStore.getState().config?.gas.swim_speed_m_per_min,
        ),
      )
      .toBe(14);
  });

  test('Display menu is in Survey and Plan (not Export), without the survey-only geometry toggle @smoke', async ({
    page,
  }) => {
    const openMenu = async () => {
      await page.locator('[data-testid="display-menu-button"]').click();
      await expect(page.locator('[data-testid="display-menu"]')).toBeVisible();
    };
    const closeMenu = async () => {
      await page.locator('[data-testid="display-menu-button"]').click();
      await expect(page.locator('[data-testid="display-menu"]')).toHaveCount(0);
    };

    // Survey: the full menu - visibility toggles + the geometry toggle + the color overlays.
    await openMenu();
    await expect(page.locator('[data-testid="display-toggle-showStations"]')).toBeVisible();
    await expect(page.locator('[data-testid="geometry-mode-measured"]')).toBeVisible();
    await expect(page.locator('[data-testid="display-color-section"]')).toBeVisible();
    await closeMenu();

    // Plan: the visibility toggles remain, but the geometry toggle (closure map is forced) and the
    // color overlays (the gas gradient owns the coloring) are gone.
    await enterMode(page, 'plan');
    await openMenu();
    await expect(page.locator('[data-testid="display-toggle-showStations"]')).toBeVisible();
    await expect(page.locator('[data-testid="geometry-mode-measured"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="display-color-section"]')).toHaveCount(0);
    await closeMenu();

    // Export: the Display menu is gone entirely - the Export panel's own controls decide what
    // the exported image contains, so a survey-style Display menu would be a confusing no-op.
    await enterMode(page, 'export');
    await expect(page.locator('[data-testid="display-menu-button"]')).toHaveCount(0);
  });

  test('adding a stage enables a pushy preset behind the advanced acknowledgment @smoke', async ({
    page,
  }) => {
    await enterMode(page, 'plan');
    await expect(page.locator('[data-testid="cylinders-table"]')).toBeVisible({ timeout: 3000 });

    // Default twin-AL80 rig has no stages → 1-stage is greyed and selecting it is impossible.
    await expect(page.locator('[data-testid="gas-reserve-one_stage"]')).toBeDisabled();

    // Add a cylinder and set its role to Stage → the rig now carries one stage.
    await page.selectOption('[data-testid="gas-add-tank"]', 'al80');
    await page.locator('[data-testid="gas-cylinder-role"]').last().selectOption('stage');

    // 1-stage is now selectable, but clicking it raises the advanced-acknowledgment gate
    // (it must NOT apply until acknowledged).
    const oneStage = page.locator('[data-testid="gas-reserve-one_stage"]');
    await expect(oneStage).toBeEnabled();
    await oneStage.click();
    await expect(page.locator('[data-testid="gas-pushy-ack"]')).toBeVisible();

    // Confirming applies the strategy (selected ring) and dismisses the gate.
    await page.locator('[data-testid="gas-pushy-ack-confirm"]').click();
    await expect(page.locator('[data-testid="gas-pushy-ack"]')).toHaveCount(0);
    await expect(oneStage).toHaveClass(/ring-accent/);

    // The staged strategy refetches a field with a route → a ▼ drop marker + the ◉ final-turn
    // marker render, and the readout gains the per-stage drop gauge.
    await expect
      .poll(() => page.locator('[data-testid="gas-drop-marker"]').count(), { timeout: 3000 })
      .toBeGreaterThan(0);
    await expect
      .poll(() => page.locator('[data-testid="gas-final-turn-marker"]').count(), { timeout: 3000 })
      .toBeGreaterThan(0);
    await expect(page.locator('[data-testid="gas-panel"]')).toContainText('Stage 1 drop');
    // The per-stage reserve input appears for a staged strategy (default 30 bar).
    await expect(page.locator('[data-testid="gas-stage-reserve-input"]')).toBeVisible();
  });

  test('a cylinder can be disabled - the row dims and it drops out of the plan (#245) @smoke', async ({
    page,
  }) => {
    await enterMode(page, 'plan');
    await expect(page.locator('[data-testid="cylinders-table"]')).toBeVisible({ timeout: 3000 });
    const firstRow = page.locator('[data-testid="gas-cylinder-row"]').first();
    const toggle = firstRow.locator('[data-testid="gas-cylinder-enabled"]');
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    // The row shows its disabled state, and the store carries the flag through to the engine.
    await expect(firstRow).toHaveAttribute('data-enabled', 'false');
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                window as unknown as {
                  __E2E_TEST__: {
                    gasPlanStore: { getState: () => { cylinders: Array<{ enabled: boolean }> } };
                  };
                }
              ).__E2E_TEST__.gasPlanStore.getState().cylinders[0].enabled,
          ),
        { timeout: 2000 },
      )
      .toBe(false);
  });

  test('disabling the only stage drops the staged reserve control (UI/backend parity #245) @smoke', async ({
    page,
  }) => {
    await enterMode(page, 'plan');
    await expect(page.locator('[data-testid="cylinders-table"]')).toBeVisible({ timeout: 3000 });
    // Carry one stage and select the (acked) 1-stage strategy → the stage-reserve control shows.
    await page.selectOption('[data-testid="gas-add-tank"]', 'al80');
    await page.locator('[data-testid="gas-cylinder-role"]').last().selectOption('stage');
    await page.locator('[data-testid="gas-reserve-one_stage"]').click();
    await page.locator('[data-testid="gas-pushy-ack-confirm"]').click();
    await expect(page.locator('[data-testid="gas-stage-reserve-input"]')).toBeVisible();

    // Disable that stage. The engine counts only ENABLED stages, so it falls back to All-thirds;
    // the panel must mirror that - the staged-only reserve control disappears and the 1-stage
    // button greys out (before the fix, stageCount counted the disabled stage and both stayed live).
    await page
      .locator('[data-testid="gas-cylinder-row"]')
      .last()
      .locator('[data-testid="gas-cylinder-enabled"]')
      .uncheck();
    await expect(page.locator('[data-testid="gas-stage-reserve-input"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="gas-reserve-one_stage"]')).toBeDisabled();
  });

  test('the Free strategy makes the usable-gas column editable per cylinder (#245) @smoke', async ({
    page,
  }) => {
    await enterMode(page, 'plan');
    await expect(page.locator('[data-testid="cylinders-table"]')).toBeVisible({ timeout: 3000 });
    // Under a reserve strategy the usable column is READ-ONLY (engine-computed).
    await expect(page.locator('[data-testid="gas-cylinder-usable-readonly"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="gas-cylinder-usable"]')).toHaveCount(0);

    // Free is advanced (manual reserves, incl. zero-reserve), so it routes through the advanced
    // acknowledgment the first time - then flips the column to an editable field per budget-role tank.
    await page.locator('[data-testid="gas-reserve-free"]').click();
    await expect(page.locator('[data-testid="gas-pushy-ack"]')).toBeVisible();
    await page.locator('[data-testid="gas-pushy-ack-confirm"]').click();
    await expect(page.locator('[data-testid="gas-reserve-free"]')).toHaveClass(/ring-accent/);
    const usable = page.locator('[data-testid="gas-cylinder-usable"]').first();
    await expect(usable).toBeVisible();

    // Typing a usable value stores it on the cylinder (metric mock ⇒ bar 1:1).
    const usableOf = (i: number) =>
      page.evaluate(
        (idx) =>
          (
            window as unknown as {
              __E2E_TEST__: {
                gasPlanStore: { getState: () => { cylinders: Array<{ usable_gas_bar: number }> } };
              };
            }
          ).__E2E_TEST__.gasPlanStore.getState().cylinders[idx].usable_gas_bar,
        i,
      );
    await usable.fill('80');
    await usable.blur();
    await expect.poll(() => usableOf(0), { timeout: 2000 }).toBe(80);

    // A diver must be able to zero out a tank's usable in Free (#245 bug: the field rejected 0).
    await usable.fill('0');
    await usable.blur();
    await expect.poll(() => usableOf(0), { timeout: 2000 }).toBe(0);
  });

  test('readout: no Turn points row; backgas label switches; stage drops show distance (#245) @smoke', async ({
    page,
  }) => {
    await enterMode(page, 'plan');
    const readout = page.locator('[data-testid="gas-readout"]');
    await expect(readout).toBeVisible({ timeout: 3000 });
    // "Turn points" row is removed.
    await expect(readout).not.toContainText('Turn points');
    // All-thirds (default, no stages): the back-gas gauge reads "turn pressure".
    await expect(readout).toContainText('Backgas turn pressure');
    await expect(readout).not.toContainText('Backgas switch pressure');

    // Add a stage + select the staged strategy → the gauge flips to "switch pressure", and the
    // stage-drop row shows both a pressure and a distance ("… @ …m").
    await page.selectOption('[data-testid="gas-add-tank"]', 'al80');
    await page.locator('[data-testid="gas-cylinder-role"]').last().selectOption('stage');
    await page.locator('[data-testid="gas-reserve-one_stage"]').click();
    await page.locator('[data-testid="gas-pushy-ack-confirm"]').click();
    await expect(readout).toContainText('Backgas switch pressure');
    await expect(readout).not.toContainText('Backgas turn pressure');
    await expect(page.locator('[data-testid="gas-readout-stage1-drop"]')).toContainText('@');
  });

  test('All-thirds safety margin input appears only in thirds and round-trips to config (#245) @smoke', async ({
    page,
  }) => {
    await enterMode(page, 'plan');
    // The margin input shows only for All-thirds (the default); the staged reserve input does not.
    const margin = page.locator('[data-testid="gas-safety-margin-input"]');
    await expect(margin).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="gas-stage-reserve-input"]')).toHaveCount(0);

    // The mock budget is a fixed 1500 regardless of margin (cylinders are ignored there), so assert
    // the input round-trips into the config instead - the budget math is unit-tested in Rust.
    await margin.fill('20');
    await margin.blur();
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                window as unknown as {
                  __E2E_TEST__: {
                    gasPlanStore: {
                      getState: () => {
                        gasConfig: { reserve_profile: { all_thirds_safety_margin_bar: number } };
                      };
                    };
                  };
                }
              ).__E2E_TEST__.gasPlanStore.getState().gasConfig.reserve_profile
                .all_thirds_safety_margin_bar,
          ),
        { timeout: 2000 },
      )
      .toBe(20);
  });

  test('Plan right-click offers gas route picks, not the survey menu; Set as endpoint stores it @smoke', async ({
    page,
  }) => {
    await enterMode(page, 'plan');
    await expect(page.locator('[data-testid="gas-panel"]')).toBeVisible({ timeout: 3000 });

    // Open the station context menu programmatically (the right-click hit-test itself is covered by
    // survey-mode specs). In Plan it must REPLACE the survey mutation menu with the gas route picks.
    await page.evaluate(() => {
      const e2e = (
        window as unknown as {
          __E2E_TEST__: {
            projectStore: { getState: () => { project: { sections: Array<{ id: number }> } } };
            uiStore: { getState: () => { openDialog: (d: string, data: unknown) => void } };
          };
        }
      ).__E2E_TEST__;
      const sec = e2e.projectStore.getState().project.sections[0];
      e2e.uiStore.getState().openDialog('context-menu', {
        target: { type: 'station', ref: { section_id: sec.id, station_index: 1 } },
        position: { x: 220, y: 220 },
      });
    });

    // The Plan menu is the route-picking menu (#298).
    await expect(planMenuItem(page, 'Set as endpoint')).toBeVisible();
    await expect(planMenuItem(page, 'Set as start point')).toBeVisible();
    await expect(planMenuItem(page, 'Set as way point')).toBeVisible();
    await expect(planMenuItem(page, 'Set marked point')).toBeVisible();
    // No stage drop entry on the default all-thirds rig: the backend returns no drops for it, so
    // offering a slot the engine would ignore would be a lie.
    await expect(page.getByRole('button', { name: /Set as stage/ })).toHaveCount(0);
    // The survey mutation menu must NOT appear (the read-only bug): no "Edit Station".
    await expect(page.getByText('Edit Station')).toHaveCount(0);

    // Picking the endpoint stores it in the gas plan store and closes the menu.
    await planMenuItem(page, 'Set as endpoint').click();
    await expect(planMenuItem(page, 'Set as endpoint')).toHaveCount(0);
    expect(await gasEndpoint(page)).not.toBeNull();
  });

  /** Open the Plan right-click menu for `stationIndex` of the first section. */
  async function openPlanMenu(page: Page, stationIndex: number): Promise<void> {
    await page.evaluate((idx) => {
      const e2e = (
        window as unknown as {
          __E2E_TEST__: {
            projectStore: { getState: () => { project: { sections: Array<{ id: number }> } } };
            uiStore: { getState: () => { openDialog: (d: string, data: unknown) => void } };
          };
        }
      ).__E2E_TEST__;
      const sec = e2e.projectStore.getState().project.sections[0];
      e2e.uiStore.getState().openDialog('context-menu', {
        target: { type: 'station', ref: { section_id: sec.id, station_index: idx } },
        position: { x: 220, y: 220 },
      });
    }, stationIndex);
  }

  test('a plain left-click on a station sets the ENDPOINT, not the origin @smoke', async ({
    page,
  }) => {
    // #298 flipped this: a map click used to re-root the origin. Picking a destination is the
    // frequent action, and the origin is nearly always the entrance.
    await enterMode(page, 'plan');
    await expect(page.locator('[data-testid="gas-panel"]')).toBeVisible({ timeout: 3000 });
    await waitForDrawnStations(page);
    // Zoom in the same way the pixel probes do: at the fit-to-bounds zoom the 11 stations are only
    // a few px apart and a click lands ambiguously between discs.
    await setMapZoom(page, (await mapZoom(page)) + PROBE_ZOOM_DELTA);
    await waitForDrawnStations(page);
    // `stationAt` is CANVAS-relative (it feeds the pixel probes); the mouse works in viewport
    // coordinates, so the canvas origin has to be added or the click lands above the map.
    const pt = await stationAt(page, 3);
    const canvasBox = await page.locator('canvas').first().boundingBox();
    expect(canvasBox).not.toBeNull();
    await page.mouse.click(canvasBox!.x + pt.x, canvasBox!.y + pt.y);

    await expect.poll(() => gasEndpoint(page), { timeout: 2000 }).not.toBeNull();
    // The origin must be untouched (still the entrance default) - the whole point of the change.
    expect(
      await page.evaluate(
        () => (window as unknown as E2EWindow).__E2E_TEST__?.gasPlanStore.getState().origin ?? null,
      ),
    ).toBeNull();
  });

  test('Set as start point sets the ORIGIN, not the endpoint (#298)', async ({ page }) => {
    await enterMode(page, 'plan');
    await expect(page.locator('[data-testid="gas-panel"]')).toBeVisible({ timeout: 3000 });
    await openPlanMenu(page, 2);
    await planMenuItem(page, 'Set as start point').click();
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as E2EWindow).__E2E_TEST__?.gasPlanStore.getState().origin ?? null,
          ),
        { timeout: 2000 },
      )
      .toEqual({ section_id: 1, station_index: 2 });
    // The origin pick must NOT double as an endpoint pick - they are separate route roles.
    expect(await gasEndpoint(page)).toBeNull();
  });

  test('way points: add, reorder, remove - order reaches the engine @smoke', async ({ page }) => {
    await enterMode(page, 'plan');
    await expect(page.locator('[data-testid="gas-panel"]')).toBeVisible({ timeout: 3000 });
    // Empty state first, so the list rows below are proof of the add and not pre-existing.
    await expect(page.locator('[data-testid="gas-waypoints-empty"]')).toBeVisible();

    await openPlanMenu(page, 2);
    await planMenuItem(page, 'Set as way point').click();
    await openPlanMenu(page, 4);
    await planMenuItem(page, 'Set as way point').click();

    // Click order IS visit order.
    await expect.poll(() => gasWaypoints(page), { timeout: 2000 }).toEqual([
      { section_id: 1, station_index: 2 },
      { section_id: 1, station_index: 4 },
    ]);
    await expect(page.locator('[data-testid="gas-waypoint-row"]')).toHaveCount(2);
    // One numbered pin per way point on the map.
    await expect(page.locator('[data-testid="gas-waypoint-marker"]')).toHaveCount(2);

    // The engine receives them, in order - this is a gas input, not a drawing hint.
    const sent = await page.evaluate(
      () =>
        (
          (window as unknown as Record<string, unknown>).__MOCK_GAS_REACH_CALLS__ as Array<{
            waypoints: StationRefLite[];
          }>
        ).at(-1)?.waypoints ?? [],
    );
    expect(sent).toEqual([
      { section_id: 1, station_index: 2 },
      { section_id: 1, station_index: 4 },
    ]);

    // Reordering is a real change of plan, so it must actually swap the list.
    await page.locator('[data-testid="gas-waypoint-down"]').first().click();
    await expect.poll(() => gasWaypoints(page), { timeout: 2000 }).toEqual([
      { section_id: 1, station_index: 4 },
      { section_id: 1, station_index: 2 },
    ]);

    await page.locator('[data-testid="gas-waypoint-remove"]').first().click();
    await expect
      .poll(() => gasWaypoints(page), { timeout: 2000 })
      .toEqual([{ section_id: 1, station_index: 2 }]);
    await expect(page.locator('[data-testid="gas-waypoint-marker"]')).toHaveCount(1);
  });

  test('marked points: pin, label, remove - and no gas recompute (#298)', async ({ page }) => {
    await enterMode(page, 'plan');
    await expect(page.locator('[data-testid="gas-panel"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="gas-marked-empty"]')).toBeVisible();
    // Let the initial field settle so the call count below reflects only what marking does.
    await expect(page.locator('[data-testid="gas-legend"]')).toBeVisible({ timeout: 3000 });
    const callsBefore = await page.evaluate(
      () =>
        ((window as unknown as Record<string, unknown>).__MOCK_GAS_REACH_CALLS__ as unknown[])
          ?.length ?? 0,
    );

    await openPlanMenu(page, 3);
    await planMenuItem(page, 'Set marked point').click();
    await expect(page.locator('[data-testid="gas-marked-row"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="gas-marked-point-marker"]')).toHaveCount(1);

    await page.locator('[data-testid="gas-marked-label-input"]').fill('photo here');
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as E2EWindow).__E2E_TEST__?.gasPlanStore.getState()
                .markedPoints[0]?.label ?? null,
          ),
        { timeout: 2000 },
      )
      .toBe('photo here');

    // A marked point is an annotation: it must never re-run the gas solve. If this ever fires, the
    // store setter has started nulling reachField and the overlay will flicker on every keystroke.
    const callsAfter = await page.evaluate(
      () =>
        ((window as unknown as Record<string, unknown>).__MOCK_GAS_REACH_CALLS__ as unknown[])
          ?.length ?? 0,
    );
    expect(callsAfter).toBe(callsBefore);

    await page.locator('[data-testid="gas-marked-remove"]').click();
    await expect(page.locator('[data-testid="gas-marked-row"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="gas-marked-point-marker"]')).toHaveCount(0);
  });

  test('the legend keys the route line and the new route symbols (#298)', async ({ page }) => {
    await enterMode(page, 'plan');
    const key = page.locator('[data-testid="gas-legend-key"]');
    await expect(key).toBeVisible({ timeout: 3000 });
    // The route line is drawn by default (origin -> deepest reachable), so its key is always there.
    await expect(key.getByText('Planned route')).toBeVisible();
    // Way point / marked point rows appear only once those exist, so the key stays short.
    await expect(key.getByText('Way point')).toHaveCount(0);
    await openPlanMenu(page, 2);
    await planMenuItem(page, 'Set as way point').click();
    await expect(key.getByText('Way point')).toBeVisible();
  });

  test('right-clicking a turn-frontier dot opens the Plan menu and sets the endpoint @smoke', async ({
    page,
  }) => {
    await enterMode(page, 'plan');
    // The red turn-frontier dots are the candidate end points; they render even with survey
    // stations hidden, so they are the route-pick target (a station right-click needs stations on).
    await expect
      .poll(() => page.locator('[data-testid="gas-turn-marker"]').count(), { timeout: 3000 })
      .toBeGreaterThan(0);
    await page.locator('[data-testid="gas-turn-marker"]').first().click({ button: 'right' });
    await expect(planMenuItem(page, 'Set as endpoint')).toBeVisible();
    await planMenuItem(page, 'Set as endpoint').click();
    expect(await gasEndpoint(page)).not.toBeNull();
  });

  test('left-clicking a turn-frontier dot selects THAT station as the route endpoint @smoke', async ({
    page,
  }) => {
    await enterMode(page, 'plan');
    await expect
      .poll(() => page.locator('[data-testid="gas-turn-marker"]').count(), { timeout: 3000 })
      .toBeGreaterThan(0);
    // Capture which station the first marker represents (markers are built in
    // turn_frontier order), so we assert the pick set THAT ref - a wrong-ref bug
    // (all markers picking the same station, or an off-by-one) would slip past a
    // mere "endpoint is non-null" check.
    const expected = (await turnFrontier(page))[0];
    expect(expected).toBeTruthy();
    // A single left click sets the endpoint directly - no menu round-trip (#243).
    await page.locator('[data-testid="gas-turn-marker"]').first().click();
    await expect.poll(() => gasEndpoint(page), { timeout: 2000 }).toEqual(expected);
    // And it must not have opened the context menu.
    await expect(planMenuItem(page, 'Set as endpoint')).toHaveCount(0);
  });

  test('keyboard-activating a turn-frontier dot (Enter) selects it and preserves focus (#243 a11y)', async ({
    page,
  }) => {
    await enterMode(page, 'plan');
    await expect
      .poll(() => page.locator('[data-testid="gas-turn-marker"]').count(), { timeout: 3000 })
      .toBeGreaterThan(0);
    await page.locator('[data-testid="gas-turn-marker"]').first().focus();
    await page.keyboard.press('Enter');
    // Enter picks the endpoint (keyboard parity with the left click)…
    await expect.poll(() => gasEndpoint(page), { timeout: 2000 }).not.toBeNull();
    // …and focus is NOT stranded on <body>: setEndpoint tears down every marker, so
    // the rebuild must re-focus the picked marker or the AT user loses their place.
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.activeElement?.getAttribute('data-testid') ?? document.body.tagName,
          ),
        { timeout: 2000 },
      )
      .toBe('gas-turn-marker');
  });

  test('undo/redo shortcuts are inert in Plan AND Export (read-only guard parity with the hidden buttons) @smoke', async ({
    page,
  }) => {
    const getCalls = () =>
      page.evaluate(
        () =>
          (
            window as unknown as { __MOCK_GET_UNDO_REDO_CALLS__: () => string[] }
          ).__MOCK_GET_UNDO_REDO_CALLS__(),
      );

    await enterMode(page, 'plan');
    await page.evaluate(() =>
      (
        window as unknown as { __MOCK_RESET_UNDO_REDO_CALLS__: () => void }
      ).__MOCK_RESET_UNDO_REDO_CALLS__(),
    );
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+y');
    expect(await getCalls()).toEqual([]);

    // Export is guarded by the same `appMode !== 'survey'` term, not a plan-specific
    // check - pin it so a refactor to `=== 'plan'` can't silently re-open Export.
    await enterMode(page, 'export');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+y');
    expect(await getCalls()).toEqual([]);

    // Survey positive control + injection proof: both fire here, so the []s above
    // reflect the guard (not a dead keystroke path), and a guard leak in Plan/Export
    // would have shown up as extra entries before this exact-equality settles.
    await enterMode(page, 'survey');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+y');
    await expect.poll(getCalls, { timeout: 2000 }).toEqual(['undo', 'redo']);
  });

  test('Ctrl+I import is blocked in Plan but works in Survey (read-only-map guard, #243) @smoke', async ({
    page,
  }) => {
    const openCount = () =>
      page.evaluate(
        () =>
          (
            window as unknown as { __MOCK_GET_DIALOG_OPEN_COUNT__: () => number }
          ).__MOCK_GET_DIALOG_OPEN_COUNT__(),
      );

    await enterMode(page, 'plan');
    await page.evaluate(() =>
      (
        window as unknown as { __MOCK_RESET_DIALOG_OPEN_COUNT__: () => void }
      ).__MOCK_RESET_DIALOG_OPEN_COUNT__(),
    );
    // The default seed has no eligible closures, so Plan's forced closureAdjusted
    // reverts to measured - the exact trap a geometryMode-only guard would miss.
    await page.keyboard.press('Control+i');
    expect(await openCount()).toBe(0);

    // Survey positive control: the picker DOES open, proving the recorder is live and
    // the 0 above is the guard, not a broken keybinding.
    await enterMode(page, 'survey');
    await page.keyboard.press('Control+i');
    await expect.poll(openCount, { timeout: 2000 }).toBeGreaterThan(0);
  });

  test('the planned route renders as a highlighted overlay @smoke', async ({ page }) => {
    await enterMode(page, 'plan');
    // The default route (origin → deepest reachable) draws the solid route line over the survey.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const map = (
              window as unknown as {
                __stalagmight_map__?: {
                  queryRenderedFeatures: (o: { layers: string[] }) => unknown[];
                };
              }
            ).__stalagmight_map__;
            try {
              return map?.queryRenderedFeatures({ layers: ['survey-gas-route'] }).length ?? 0;
            } catch {
              return 0;
            }
          }),
        { timeout: 4000 },
      )
      .toBeGreaterThan(0);

    // Jump legs are FADED, not dashed (#243): one line layer, opacity driven by a
    // data expression on `isJump`. Pin the expression so reverting to a constant
    // opacity (or typo-ing the property) - which MapLibre evaluates silently - fails.
    const opacity = await page.evaluate(() => {
      const map = (
        window as unknown as {
          __stalagmight_map__?: { getPaintProperty: (l: string, p: string) => unknown };
        }
      ).__stalagmight_map__;
      try {
        return JSON.stringify(map?.getPaintProperty('survey-gas-route', 'line-opacity'));
      } catch {
        return '';
      }
    });
    expect(opacity).toContain('isJump');
    expect(opacity).toContain('0.45');
  });

  test('carousel switches Survey/Plan/Export; Plan is read-only; Export has controls @smoke', async ({
    page,
  }) => {
    await expect(page.locator('[data-testid="mode-carousel"]')).toBeVisible();

    // Export directly from Survey: the right Dock must reveal the panel (it would stay
    // hidden in a closed dock if entry didn't reveal it).
    await enterMode(page, 'export');
    expect(await appMode(page)).toBe('export');
    await expect(page.locator('[data-testid="export-panel"]')).toBeVisible({ timeout: 3000 });

    // Plan: setup sidebar + tabbed tables; the map is read-only.
    await enterMode(page, 'plan');
    expect(await appMode(page)).toBe('plan');
    await expect(page.locator('[data-testid="gas-panel"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="plan-tables-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="cylinders-table"]')).toBeVisible();
    // Mutating tools (merge/comment/move) are HIDDEN in Plan, not just disabled; the
    // non-mutating Select/Pan/Measure remain.
    await expect(page.locator('[data-testid="tool-merge"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="tool-select"]')).toBeVisible();
    await expect(page.locator('[data-testid="tool-measure"]')).toBeVisible();
    // Import and Undo/Redo are likewise HIDDEN in the read-only workspaces (#243).
    await expect(page.locator('[data-testid="toolbar-import-button"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="toolbar-undo-button"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="toolbar-redo-button"]')).toHaveCount(0);
    // A mutating tool selected programmatically (e.g. via shortcut) snaps back to select.
    await page.evaluate(() =>
      (window as unknown as E2EWindow).__E2E_TEST__?.uiStore.getState().setActiveTool('merge'),
    );
    await expect.poll(() => activeTool(page), { timeout: 2000 }).toBe('select');
    // Profile tab is a stub.
    await page.locator('[data-testid="plan-tab-profile"]').click();
    await expect(page.locator('[data-testid="plan-profile-stub"]')).toBeVisible();

    // Export: panel hosts the real export controls (no longer a stub), no gas/plan tables.
    await enterMode(page, 'export');
    expect(await appMode(page)).toBe('export');
    await expect(page.locator('[data-testid="export-panel"]')).toBeVisible({ timeout: 3000 });
    await expect(
      page.locator('[data-testid="export-panel"]').getByTestId('export-button'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="gas-panel"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="plan-tables-panel"]')).toHaveCount(0);
    // Export hides the file/history controls too (#243).
    await expect(page.locator('[data-testid="toolbar-import-button"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="toolbar-undo-button"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="toolbar-redo-button"]')).toHaveCount(0);

    // Back to Survey.
    await enterMode(page, 'survey');
    expect(await appMode(page)).toBe('survey');
    await expect(page.locator('[data-testid="export-panel"]')).toHaveCount(0);
    // The survey toolbar gets its file/history controls back (#243).
    await expect(page.locator('[data-testid="toolbar-import-button"]')).toBeVisible();
    await expect(page.locator('[data-testid="toolbar-undo-button"]')).toBeVisible();
    await expect(page.locator('[data-testid="toolbar-redo-button"]')).toBeVisible();
  });

  test('Export panel: inline controls, large WYSIWYG preview, colors are raster-only', async ({
    page,
  }) => {
    await enterMode(page, 'export');
    expect(await appMode(page)).toBe('export');

    const panel = page.locator('[data-testid="export-panel"]');
    await expect(panel).toBeVisible({ timeout: 3000 });

    // Defaults to the image type → the large WYSIWYG preview overlays the map area.
    await expect(page.locator('[data-testid="export-mode-preview"]')).toBeVisible();
    await expect(panel.getByTestId('export-type-image')).toBeChecked();

    // The label/color controls live in a collapsible "Comments & Labels Options"
    // section, collapsed by default to keep the panel uncluttered. Expand it.
    await expect(panel.getByTestId('export-show-labels')).toHaveCount(0);
    await panel.getByTestId('export-labels-options-toggle').click();

    // The full label toggle set is present (mirrors the Display tab's group),
    // alongside the penetration toggle and the Color dropdown.
    await expect(panel.getByTestId('export-show-section-names')).toBeVisible();
    await expect(panel.getByTestId('export-show-station-labels')).toBeVisible();
    await expect(panel.getByTestId('export-show-station-comments')).toBeVisible();
    await expect(panel.getByTestId('export-show-shot-comments')).toBeVisible();
    await expect(panel.getByTestId('export-show-shot-data')).toBeVisible();
    // The penetration-labels toggle + the Color dropdown, which offers the
    // depth/distance/section gradients that match the survey map.
    await expect(panel.getByTestId('export-show-labels')).toBeVisible();
    const colorSelect = panel.getByTestId('export-color-mode');
    await expect(colorSelect).toBeVisible();
    await colorSelect.locator('button').first().click();
    const colorList = page.getByRole('listbox');
    await expect(colorList.locator('[role="option"]:has-text("By depth")')).toBeVisible();
    await expect(colorList.locator('[role="option"]:has-text("By distance")')).toBeVisible();
    await colorList.locator('[role="option"]:has-text("By depth")').click();

    // Switch the format to SVG → the Color dropdown disables (SVG is always monochrome).
    const formatSelect = panel.getByTestId('image-format-select');
    await formatSelect.locator('button').first().click();
    await page.getByRole('listbox').locator('[role="option"]:has-text("SVG")').click();
    await expect(colorSelect.locator('button').first()).toBeDisabled();

    // Switch to the data export type → the map preview overlay goes away.
    await panel.getByTestId('export-type-data').click();
    await expect(page.locator('[data-testid="export-mode-preview"]')).toHaveCount(0);
  });

  test('Plan map is read-only: Delete on a selection opens no confirm dialog @smoke', async ({
    page,
  }) => {
    await enterMode(page, 'plan');
    // Select a shot via the store, then press Delete. Plan/Export are read-only even on a
    // no-closures project (where geometryMode falls back to 'measured'), so the appMode
    // guard must block the delete - no confirm dialog opens.
    await page.evaluate(() => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              project: { sections: Array<{ id: number; shots: Array<{ id: number }> }> } | null;
            };
          };
          uiStore: {
            getState: () => {
              setSelection: (s: { type: string; sectionId: number; shotId: number }) => void;
            };
          };
        };
      }).__E2E_TEST__;
      const sec = e2e!.projectStore.getState().project!.sections[0];
      e2e!.uiStore
        .getState()
        .setSelection({ type: 'shot', sectionId: sec.id, shotId: sec.shots[0].id });
    });
    await page.keyboard.press('Delete');
    await expect(page.locator('[data-testid="confirm-dialog"]')).toHaveCount(0);
  });

  test('Plan stars the zero datum; clicking the star picks it as the origin @smoke', async ({
    page,
  }) => {
    // Flag station 0 of the first section as a zero datum, then refresh so the map
    // reflects it (the gas solve's "Entrance" default already starts from the datum;
    // this marks it so the user can see + pick it).
    await page.evaluate(async () => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              project: { sections: Array<{ id: number }> } | null;
              setZeroDatum: (
                ref: { section_id: number; station_index: number },
                gps: { latitude: number; longitude: number; depth_reference: number },
              ) => Promise<unknown>;
              refreshProjectState: () => Promise<void>;
            };
          };
        };
      }).__E2E_TEST__;
      const ps = e2e!.projectStore.getState();
      const secId = ps.project!.sections[0].id;
      await ps.setZeroDatum(
        { section_id: secId, station_index: 0 },
        { latitude: 24.55, longitude: -81.78, depth_reference: 0 },
      );
      await ps.refreshProjectState();
    });

    await enterMode(page, 'plan');
    // The black star renders on the zero-datum station.
    await expect
      .poll(() => page.locator('[data-testid="gas-zero-datum-marker"]').count(), { timeout: 3000 })
      .toBeGreaterThan(0);
    // Default origin is the entrance; clicking the star picks the datum explicitly, so
    // the readout leaves "Entrance" for the station id.
    const readout = page.locator('[data-testid="gas-origin-readout"]');
    await expect(readout).toHaveText('Entrance');
    await page.locator('[data-testid="gas-zero-datum-marker"]').first().click();
    await expect(readout).not.toHaveText('Entrance');
  });

  test('the gas ramp survives a feature rebuild, and a turn marker renders', async ({ page }) => {
    await waitForDrawnStations(page, 1);
    const zoom = (await mapZoom(page)) + PROBE_ZOOM_DELTA;
    await setMapZoom(page, zoom);
    const grey = await greyKey(page);
    const sectionKey = (await stationCenter(page, LAST_REACHABLE)).join(',');

    await enterMode(page, 'plan');
    await setMapZoom(page, zoom);
    await expect.poll(() => stationPaints(page, 0, GAS_NEAR_KEY), { timeout: 3000 }).toBe(true);
    // The last station inside the budget is painted an interior ramp color, the
    // over-budget one grey. Snapshot the reachable one's whole footprint so "still
    // ramp-painted after the rebuild" can be asserted byte-for-byte.
    const reachableBefore = await stationBlock(page, LAST_REACHABLE);
    const reachableColors = await stationColors(page, LAST_REACHABLE);
    expect(reachableColors.has(sectionKey)).toBe(false);
    expect(reachableColors.has(GAS_NEAR_KEY)).toBe(false);
    expect(reachableColors.has(grey)).toBe(false);
    expect(await stationPaints(page, OVER_BUDGET, grey)).toBe(true);
    // The mock's fixed budget leaves the far stations unreachable, so the turn
    // frontier is non-empty → at least one turn marker renders.
    await expect
      .poll(() => page.locator('[data-testid="gas-turn-marker"]').count(), { timeout: 3000 })
      .toBeGreaterThan(0);

    // A survey edit rebuilds every feature (the custom renderer rebuilds its vertex
    // buffers from scratch; the stock path had setData wipe the feature-state). The
    // overlay must re-apply its ramp afterward, the key correctness risk.
    await seedProjectWithSections(page, [
      {
        name: 'Gas B',
        direction: 'in',
        shots: [{ azimuth_in: 0, azimuth_out: 180, length: 5, depth_in: -3, depth_out: -9 }],
      },
    ]);
    // The rebuild can re-fit the view, so re-pin the calibrated zoom.
    await setMapZoom(page, zoom);
    await waitForDrawnStations(page, 1);

    // The rebuilt stations are painted exactly what they were: the ramp re-applied.
    // (Probed on the first section's far stations, which the new section does not
    // overlap: the mock lays every section out along the same axis and never bumps
    // `modified_at` on create_section, the field's refetch key, so the new section's
    // stations paint grey where they land on top of the first two of this one.)
    await expect.poll(() => stationBlock(page, LAST_REACHABLE), { timeout: 3000 }).toEqual(reachableBefore);
    const overBudget = await stationColors(page, OVER_BUDGET);
    expect(overBudget.has(grey)).toBe(true);
    expect(overBudget.has(sectionKey)).toBe(false);
    await expect(page.locator('[data-testid="gas-legend"]')).toBeVisible();
  });

  test('a stage drop is keyboard-movable - ArrowLeft pins it, sends an override, reset clears it (#246) @smoke', async ({
    page,
  }) => {
    await setupOneStageDrop(page);
    const marker = page.locator('[data-testid="gas-drop-marker"]').first();
    await marker.focus();
    // Nudge one route station SHALLOWER - deterministic (the default drop is never at the origin).
    await page.keyboard.press('ArrowLeft');
    // The store pins the drop AND the backend is re-invoked with the override (the full-recompute wiring).
    await expect
      .poll(async () => (await stageDropOverrides(page)).some((r) => r != null), { timeout: 3000 })
      .toBe(true);
    await expect
      .poll(async () => (await lastGasReachOverrides(page)).some((r) => r != null), { timeout: 3000 })
      .toBe(true);
    // a11y: focus survives the recompute - the rebuilt ▼ marker regains focus so an AT user can
    // chain nudges (regression guard for the stale-field-rebuild focus loss the review caught).
    await expect(page.locator('[data-testid="gas-drop-marker"]').first()).toBeFocused();
    // The readout offers a per-drop reset; clicking it clears the override and the field recomputes.
    const reset = page.locator('[data-testid="gas-readout-stage1-reset"]');
    await expect(reset).toBeVisible();
    await reset.click();
    await expect
      .poll(async () => (await stageDropOverrides(page)).every((r) => r == null), { timeout: 3000 })
      .toBe(true);
    await expect(reset).toHaveCount(0);
  });

  test('dragging a stage drop deeper flags it over-reserve (red marker + panel warning) (#246)', async ({
    page,
  }) => {
    await setupOneStageDrop(page);
    const marker = page.locator('[data-testid="gas-drop-marker"]').first();
    const finalTurn = page.locator('[data-testid="gas-final-turn-marker"]').first();
    const from = await marker.boundingBox();
    const to = await finalTurn.boundingBox();
    expect(from).not.toBeNull();
    expect(to).not.toBeNull();
    // Drag the ▼ onto the deepest (final-turn) station - deeper than its computed drop => over-reserve.
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 12 });
    await page.mouse.up();
    // The recomputed field marks the drop over-reserve → the marker turns red and the panel warns.
    await expect
      .poll(
        () => page.locator('[data-testid="gas-drop-marker"][data-over-reserve="true"]').count(),
        { timeout: 3000 },
      )
      .toBeGreaterThan(0);
    await expect(page.locator('[data-testid="gas-readout-over-reserve-warning"]')).toBeVisible();
  });
});
