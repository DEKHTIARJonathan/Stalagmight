import { test, expect, Page } from './fixtures/coverage';
import { setupTauriMocks } from './mocks/tauri-ipc';
import { seedProjectWithSections, type SectionSeed } from './helpers/app';

/**
 * E2E for the distance-gradient overlay (#34). Unlike depth (which bakes a
 * `color` property), distance colors via `setFeatureState('dist')` + a swapped
 * `circle-color`/`line-color` interpolate paint, so we assert on the paint
 * expression + feature-state + the legend, and verify the overlay survives a
 * feature rebuild (the key correctness risk — MapLibre clears feature-state on
 * setData).
 */

async function createProject(page: Page, name: string): Promise<void> {
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill(name);
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await page.waitForSelector('canvas', { timeout: 10000 });
}

const sectionSeeds: SectionSeed[] = [
  {
    name: 'Distance A',
    direction: 'in',
    shots: [
      { azimuth_in: 45, azimuth_out: 225, length: 12, depth_in: 0, depth_out: -6 },
      { azimuth_in: 90, azimuth_out: 270, length: 8, depth_in: -6, depth_out: -12 },
    ],
  },
  {
    name: 'Distance B',
    direction: 'out',
    shots: [{ azimuth_in: 180, azimuth_out: 0, length: 6, depth_in: -12, depth_out: -3 }],
  },
];

async function openDisplayMenu(page: Page): Promise<void> {
  await page.locator('button:has-text("Display")').click();
  await expect(page.locator('[data-testid="display-toggle-showStations"]')).toBeVisible({ timeout: 2000 });
}

async function isToggleOn(page: Page, toggleKey: string): Promise<boolean> {
  return (await page.locator(`[data-testid="display-toggle-${toggleKey}"]`).getAttribute('aria-pressed')) === 'true';
}

async function toggleDisplayOption(page: Page, toggleKey: string): Promise<void> {
  const colorKeys = ['showDepthGradient', 'showDistanceGradient', 'showIssueSeverity'];
  const before = await isToggleOn(page, toggleKey);
  // Color modes are single-select: turn one OFF by selecting Section, not by re-clicking the pill.
  if (before && colorKeys.includes(toggleKey)) {
    await page.locator('[data-testid="display-color-section"]').click();
  } else {
    await page.locator(`[data-testid="display-toggle-${toggleKey}"]`).click();
  }
  await expect.poll(async () => isToggleOn(page, toggleKey), { timeout: 2000 }).not.toBe(before);
}

async function waitForMapLoaded(page: Page): Promise<void> {
  await expect.poll(async () => {
    return page.evaluate(() => {
      const map = (window as unknown as { __stalagmight_map__?: { loaded: () => boolean } }).__stalagmight_map__;
      return map?.loaded() ?? false;
    });
  }, { timeout: 10000 }).toBe(true);
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

/** Whether ANY rendered station carries a numeric `dist` feature-state. Robust to
 * render order and to unreachable stations (which may lack a dist). */
async function anyStationHasDist(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const map = (window as unknown as {
      __stalagmight_map__?: {
        queryRenderedFeatures: (o: { layers: string[] }) => Array<{ id?: number }>;
        getFeatureState: (f: { source: string; id: number }) => { dist?: number };
      };
    }).__stalagmight_map__;
    if (!map) return false;
    return map.queryRenderedFeatures({ layers: ['survey-stations'] }).some((f) => {
      if (f.id == null) return false;
      const state = map.getFeatureState({ source: 'survey-data-stations', id: f.id });
      return typeof state?.dist === 'number';
    });
  });
}

/** `dist` feature-state of the first rendered station, if any. */
async function firstStationDist(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const map = (window as unknown as {
      __stalagmight_map__?: {
        queryRenderedFeatures: (o: { layers: string[] }) => Array<{ id?: number }>;
        getFeatureState: (f: { source: string; id: number }) => { dist?: number };
      };
    }).__stalagmight_map__;
    if (!map) return null;
    const feats = map.queryRenderedFeatures({ layers: ['survey-stations'] });
    const id = feats[0]?.id;
    if (id == null) return null;
    const state = map.getFeatureState({ source: 'survey-data-stations', id });
    return typeof state?.dist === 'number' ? state.dist : null;
  });
}

test.describe('Distance Gradient', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await createProject(page, 'Distance Gradient Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapLoaded(page);
  });

  test('toggle enables the overlay (paint + feature-state + legend) and off clears it', async ({ page }) => {
    await openDisplayMenu(page);
    expect(await isToggleOn(page, 'showDistanceGradient')).toBe(false);

    // Wait for stations to render, then capture the baseline paint.
    await expect.poll(async () => {
      return page.evaluate(() => {
        const map = (window as unknown as {
          __stalagmight_map__?: { queryRenderedFeatures: (o: { layers: string[] }) => unknown[] };
        }).__stalagmight_map__;
        try { return map?.queryRenderedFeatures({ layers: ['survey-stations'] }).length ?? 0; } catch { return 0; }
      });
    }, { timeout: 5000 }).toBeGreaterThan(0);
    const paintBefore = await stationColorPaint(page);
    expect(paintBefore).toContain('color'); // ['get','color']
    expect(paintBefore).not.toContain('feature-state');

    await toggleDisplayOption(page, 'showDistanceGradient');

    // Legend appears.
    await expect(page.locator('[data-testid="distance-legend"]')).toBeVisible({ timeout: 3000 });
    // Default origin label.
    await expect(page.locator('[data-testid="distance-legend-origin"]')).toContainText('entrance');
    // Paint swapped to a feature-state interpolate.
    await expect.poll(() => stationColorPaint(page), { timeout: 3000 }).toContain('feature-state');
    // A station carries a numeric `dist` feature-state.
    await expect.poll(() => firstStationDist(page), { timeout: 3000 }).not.toBeNull();

    // Toggle off → legend gone, paint restored.
    await toggleDisplayOption(page, 'showDistanceGradient');
    await expect(page.locator('[data-testid="distance-legend"]')).not.toBeVisible();
    await expect.poll(() => stationColorPaint(page), { timeout: 3000 }).not.toContain('feature-state');
  });

  test('enabling depth gradient disables the distance overlay (mutually exclusive)', async ({ page }) => {
    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showDistanceGradient');
    await expect.poll(() => stationColorPaint(page), { timeout: 3000 }).toContain('feature-state');
    await expect(page.locator('[data-testid="distance-legend"]')).toBeVisible({ timeout: 3000 });

    // Depth and distance both paint the shots layer, so they're mutually exclusive
    // (#34, report of mixed depth-colored shots + distance-colored
    // stations). Enabling depth turns the distance overlay off.
    await toggleDisplayOption(page, 'showDepthGradient');

    expect(await isToggleOn(page, 'showDistanceGradient')).toBe(false);
    await expect(page.locator('[data-testid="distance-legend"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="depth-legend"]')).toBeVisible();
    await expect.poll(() => stationColorPaint(page), { timeout: 3000 }).not.toContain('feature-state');
  });

  test('distance feature-state survives a feature rebuild (re-applied)', async ({ page }) => {
    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showDistanceGradient');
    await expect.poll(() => stationColorPaint(page), { timeout: 3000 }).toContain('feature-state');
    await expect.poll(() => firstStationDist(page), { timeout: 3000 }).not.toBeNull();

    // A survey edit bumps the project: the layer rebuilds features (setData wipes
    // feature-state) and the field refetches. The overlay must re-apply its `dist`
    // feature-state afterward — the key MapLibre correctness risk. (Depth toggle can
    // no longer be the trigger since it now disables distance.)
    await seedProjectWithSections(page, [
      {
        name: 'Distance C',
        direction: 'in',
        shots: [{ azimuth_in: 0, azimuth_out: 180, length: 5, depth_in: -3, depth_out: -9 }],
      },
    ]);

    await expect.poll(() => stationColorPaint(page), { timeout: 3000 }).toContain('feature-state');
    await expect.poll(() => anyStationHasDist(page), { timeout: 3000 }).toBe(true);
    await expect(page.locator('[data-testid="distance-legend"]')).toBeVisible();
  });
});
