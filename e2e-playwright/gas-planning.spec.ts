import { test, expect, Page } from './fixtures/coverage';
import { setupTauriMocks } from './mocks/tauri-ipc';
import { seedProjectWithSections, type SectionSeed } from './helpers/app';

/**
 * E2E for the gas reachable-frontier overlay, now the Plan workspace mode (#38,
 * the workspace-mode reframe). Plan is entered from the top-middle Survey/Plan/Export carousel
 * (not the old toolbar toggle); it forces the read-only closure map, swaps the right
 * Dock for the gas setup sidebar, and the bottom Dock for the tabbed plan tables.
 *
 * Like the sibling distance-gradient overlay, gas colors via
 * `setFeatureState('gasReach')` + a swapped `circle-color`/`line-color` paint — so we
 * assert on the paint expression + feature-state + legend, and that the overlay
 * survives a feature rebuild (the MapLibre setData-wipe risk). The IPC field is mocked
 * (`compute_gas_reach_field`).
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
// far stations out of range — so the overlay has both reachable (gold→purple) and
// unreachable (grey) stations and a non-empty turn frontier.
const sectionSeeds: SectionSeed[] = [
  {
    name: 'Gas A',
    direction: 'in',
    // Positive depths (z = depth, positive below surface — the real convention), so the route
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

type E2EWindow = {
  __E2E_TEST__?: {
    uiStore: {
      getState: () => { appMode: string; activeTool: string; setActiveTool: (t: string) => void };
    };
  };
};

async function appMode(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as E2EWindow).__E2E_TEST__?.uiStore.getState().appMode ?? '');
}

async function activeTool(page: Page): Promise<string> {
  return page.evaluate(
    () => (window as unknown as E2EWindow).__E2E_TEST__?.uiStore.getState().activeTool ?? '',
  );
}

/** circle-color paint of the stations layer, JSON-stringified. */
async function stationColorPaint(page: Page): Promise<string> {
  return page.evaluate(() => {
    const map = (window as unknown as {
      __stalagmight_map__?: { getPaintProperty: (l: string, p: string) => unknown };
    }).__stalagmight_map__;
    if (!map) return '';
    try {
      return JSON.stringify(map.getPaintProperty('survey-stations', 'circle-color'));
    } catch {
      return '';
    }
  });
}

/** Whether ANY rendered station carries a numeric `gasReach` feature-state. */
async function anyStationHasGasReach(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const map = (window as unknown as {
      __stalagmight_map__?: {
        queryRenderedFeatures: (o: { layers: string[] }) => Array<{ id?: number }>;
        getFeatureState: (f: { source: string; id: number }) => { gasReach?: number };
      };
    }).__stalagmight_map__;
    if (!map) return false;
    return map.queryRenderedFeatures({ layers: ['survey-stations'] }).some((f) => {
      if (f.id == null) return false;
      const state = map.getFeatureState({ source: 'survey-data-stations', id: f.id });
      // >= 0 (not just "is a number"): the UNREACHABLE_GAS sentinel is -1, which is
      // also a number, so this proves the reachable gold→purple ramp is populated —
      // not that every station went grey/unreachable.
      return typeof state?.gasReach === 'number' && state.gasReach >= 0;
    });
  });
}

async function enterMode(page: Page, mode: 'survey' | 'plan' | 'export'): Promise<void> {
  await page.locator(`[data-testid="mode-${mode}"]`).click();
}

test.describe('Gas planning', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await createProject(page, 'Gas Planning Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapLoaded(page);
  });

  test('Plan mode shows the gas overlay (panel + paint + legend); back to Survey resets @smoke', async ({
    page,
  }) => {
    expect(await appMode(page)).toBe('survey');
    await expect(page.locator('[data-testid="gas-panel"]')).toHaveCount(0);

    // Wait for stations to render, then capture the baseline paint.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const map = (window as unknown as {
              __stalagmight_map__?: { queryRenderedFeatures: (o: { layers: string[] }) => unknown[] };
            }).__stalagmight_map__;
            try {
              return map?.queryRenderedFeatures({ layers: ['survey-stations'] }).length ?? 0;
            } catch {
              return 0;
            }
          }),
        { timeout: 5000 },
      )
      .toBeGreaterThan(0);
    const paintBefore = await stationColorPaint(page);
    expect(paintBefore).not.toContain('gasReach');

    await enterMode(page, 'plan');
    expect(await appMode(page)).toBe('plan');

    // The setup sidebar replaces the detail panel in the right Dock slot.
    await expect(page.locator('[data-testid="gas-panel"]')).toBeVisible({ timeout: 3000 });
    // Legend appears with the entrance origin.
    await expect(page.locator('[data-testid="gas-legend"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="gas-legend-origin"]')).toContainText('entrance');
    // The symbol key explains the markers (turn/end point always present in Plan).
    await expect(page.locator('[data-testid="gas-legend-key"]')).toContainText('Turn / end point');
    // Paint swapped to the gas feature-state interpolate.
    await expect.poll(() => stationColorPaint(page), { timeout: 3000 }).toContain('gasReach');
    // A station carries a numeric `gasReach` feature-state.
    await expect.poll(() => anyStationHasGasReach(page), { timeout: 3000 }).toBe(true);

    // Back to Survey → panel + legend gone, paint restored, store reset.
    await enterMode(page, 'survey');
    expect(await appMode(page)).toBe('survey');
    await expect(page.locator('[data-testid="gas-panel"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="gas-legend"]')).not.toBeVisible();
    await expect.poll(() => stationColorPaint(page), { timeout: 3000 }).not.toContain('gasReach');
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
    // so these readouts show "0.0 m" here regardless of the seed — there's no meaningful depth value
    // to assert at the mock level. The exact distance/depth math (tie-exclusion, deepest-point, sign)
    // is pinned in the Rust unit tests (gas/tests.rs).
    await expect(page.locator('[data-testid="gas-readout-max-depth"]')).toBeVisible();
    await expect(page.locator('[data-testid="gas-readout-avg-depth"]')).toBeVisible();
  });

  test('Plan swim speed persists to the saved config @smoke', async ({ page }) => {
    await enterMode(page, 'plan');
    const swim = page.locator('[data-testid="gas-swim-speed-input"]');
    await expect(swim).toBeVisible({ timeout: 3000 });
    // Editing swim speed writes back to the saved config (#236) — unlike the panel's other
    // per-session inputs — so it sticks across Plan exit / restart and stays in sync with Settings.
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

    // Survey: the full menu — visibility toggles + the geometry toggle + the color overlays.
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

    // Export: the Display menu is gone entirely — the Export panel's own controls decide what
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
    await expect(page.locator('[data-testid="gas-panel"]')).toContainText('Stage 1 drop pressure');
    // The per-stage reserve input appears for a staged strategy (default 30 bar).
    await expect(page.locator('[data-testid="gas-stage-reserve-input"]')).toBeVisible();
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

    await expect(page.getByText('Set as endpoint')).toBeVisible();
    // "Set as origin" was removed from the right-click menu — origin is set by single-click / the
    // datum star, and the menu is reserved for the endpoint pick + future recalc affordances.
    await expect(page.getByText('Set as origin')).toHaveCount(0);
    // The survey mutation menu must NOT appear (the read-only bug): no "Edit Station".
    await expect(page.getByText('Edit Station')).toHaveCount(0);

    // Picking the endpoint stores it in the gas plan store and closes the menu.
    await page.getByText('Set as endpoint').click();
    await expect(page.getByText('Set as endpoint')).toHaveCount(0);
    const endpoint = await page.evaluate(
      () =>
        (
          window as unknown as {
            __E2E_TEST__: { gasPlanStore: { getState: () => { endpoint: unknown } } };
          }
        ).__E2E_TEST__.gasPlanStore.getState().endpoint,
    );
    expect(endpoint).not.toBeNull();
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
    await expect(page.getByText('Set as endpoint')).toBeVisible();
    await page.getByText('Set as endpoint').click();
    const endpoint = await page.evaluate(
      () =>
        (
          window as unknown as {
            __E2E_TEST__: { gasPlanStore: { getState: () => { endpoint: unknown } } };
          }
        ).__E2E_TEST__.gasPlanStore.getState().endpoint,
    );
    expect(endpoint).not.toBeNull();
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

    // Back to Survey.
    await enterMode(page, 'survey');
    expect(await appMode(page)).toBe('survey');
    await expect(page.locator('[data-testid="export-panel"]')).toHaveCount(0);
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

    // Customize controls: the penetration-labels toggle + the Color dropdown, which
    // offers the depth/distance/section gradients that match the survey map.
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
    // guard must block the delete — no confirm dialog opens.
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

  test('gas feature-state survives a feature rebuild, and a turn marker renders', async ({
    page,
  }) => {
    await enterMode(page, 'plan');
    await expect.poll(() => stationColorPaint(page), { timeout: 3000 }).toContain('gasReach');
    await expect.poll(() => anyStationHasGasReach(page), { timeout: 3000 }).toBe(true);
    // The mock's fixed budget leaves the far stations unreachable, so the turn
    // frontier is non-empty → at least one turn marker renders.
    await expect
      .poll(() => page.locator('[data-testid="gas-turn-marker"]').count(), { timeout: 3000 })
      .toBeGreaterThan(0);

    // A survey edit bumps the project: the layer rebuilds features (setData wipes
    // feature-state) and the field refetches. The overlay must re-apply its
    // `gasReach` feature-state afterward — the key MapLibre correctness risk.
    await seedProjectWithSections(page, [
      {
        name: 'Gas B',
        direction: 'in',
        shots: [{ azimuth_in: 0, azimuth_out: 180, length: 5, depth_in: -3, depth_out: -9 }],
      },
    ]);

    await expect.poll(() => stationColorPaint(page), { timeout: 3000 }).toContain('gasReach');
    await expect.poll(() => anyStationHasGasReach(page), { timeout: 3000 }).toBe(true);
    await expect(page.locator('[data-testid="gas-legend"]')).toBeVisible();
  });
});
