import { test, expect, Page } from './fixtures/coverage';
import { setupTauriMocks } from './mocks/tauri-ipc';
import { seedProjectWithSections, type SectionSeed } from './helpers/app';

/**
 * E2E for the gas reachable-frontier overlay, now the Plan workspace mode (#38,
 * Daniel's reframe). Plan is entered from the top-middle Survey/Plan/Export carousel
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

  test('carousel switches Survey/Plan/Export; Plan is read-only; Export is a stub @smoke', async ({
    page,
  }) => {
    await expect(page.locator('[data-testid="mode-carousel"]')).toBeVisible();

    // Plan: setup sidebar + tabbed tables; the map is read-only.
    await enterMode(page, 'plan');
    expect(await appMode(page)).toBe('plan');
    await expect(page.locator('[data-testid="gas-panel"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="plan-tables-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="cylinders-table"]')).toBeVisible();
    // A mutating tool selected programmatically snaps back to select (read-only map).
    await page.evaluate(() =>
      (window as unknown as E2EWindow).__E2E_TEST__?.uiStore.getState().setActiveTool('merge'),
    );
    await expect.poll(() => activeTool(page), { timeout: 2000 }).toBe('select');
    // Profile tab is a stub.
    await page.locator('[data-testid="plan-tab-profile"]').click();
    await expect(page.locator('[data-testid="plan-profile-stub"]')).toBeVisible();

    // Export: stub panel, no gas/plan tables.
    await enterMode(page, 'export');
    expect(await appMode(page)).toBe('export');
    await expect(page.locator('[data-testid="export-panel"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="export-svg-button"]')).toBeVisible();
    await expect(page.locator('[data-testid="gas-panel"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="plan-tables-panel"]')).toHaveCount(0);

    // Back to Survey.
    await enterMode(page, 'survey');
    expect(await appMode(page)).toBe('survey');
    await expect(page.locator('[data-testid="export-panel"]')).toHaveCount(0);
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
