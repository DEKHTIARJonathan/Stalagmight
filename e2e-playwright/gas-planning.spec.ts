import { test, expect, Page } from './fixtures/coverage';
import { setupTauriMocks } from './mocks/tauri-ipc';
import { seedProjectWithSections, type SectionSeed } from './helpers/app';

/**
 * E2E for the gas reachable-frontier sub-mode (#38). Like the sibling
 * distance-gradient overlay, gas colors via `setFeatureState('gasReach')` + a
 * swapped `circle-color`/`line-color` interpolate paint — so we assert on the paint
 * expression + feature-state + the legend, and that the overlay survives a feature
 * rebuild (the MapLibre setData-wipe correctness risk). The sub-mode is entered from
 * a top-level toolbar toggle (outside the Display menu), and its inputs render in the
 * detail Dock slot, swapping out the normal DetailPanel. The IPC field is mocked
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
    shots: Array.from({ length: 10 }, (_, i) => ({
      azimuth_in: 90,
      azimuth_out: 270,
      length: 10,
      depth_in: -i,
      depth_out: -(i + 1),
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

async function gasPlanActive(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: { uiStore: { getState: () => { showGasPlan: boolean } } };
    }).__E2E_TEST__;
    return e2e?.uiStore.getState().showGasPlan ?? false;
  });
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
      return typeof state?.gasReach === 'number';
    });
  });
}

async function toggleGasPlan(page: Page): Promise<void> {
  await page.locator('[data-testid="toolbar-gas-plan-button"]').click();
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

  test('toolbar toggle enters the sub-mode (panel + overlay + legend) and exit resets @smoke', async ({
    page,
  }) => {
    expect(await gasPlanActive(page)).toBe(false);
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

    await toggleGasPlan(page);
    expect(await gasPlanActive(page)).toBe(true);

    // The input panel replaces the detail panel in the Dock slot.
    await expect(page.locator('[data-testid="gas-panel"]')).toBeVisible({ timeout: 3000 });
    // Legend appears with the entrance origin.
    await expect(page.locator('[data-testid="gas-legend"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="gas-legend-origin"]')).toContainText('entrance');
    // Paint swapped to the gas feature-state interpolate.
    await expect.poll(() => stationColorPaint(page), { timeout: 3000 }).toContain('gasReach');
    // A station carries a numeric `gasReach` feature-state.
    await expect.poll(() => anyStationHasGasReach(page), { timeout: 3000 }).toBe(true);

    // Exit → panel + legend gone, paint restored, store flag cleared.
    await toggleGasPlan(page);
    expect(await gasPlanActive(page)).toBe(false);
    await expect(page.locator('[data-testid="gas-panel"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="gas-legend"]')).not.toBeVisible();
    await expect.poll(() => stationColorPaint(page), { timeout: 3000 }).not.toContain('gasReach');
  });

  test('gas feature-state survives a feature rebuild, and a turn marker renders', async ({
    page,
  }) => {
    await toggleGasPlan(page);
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
