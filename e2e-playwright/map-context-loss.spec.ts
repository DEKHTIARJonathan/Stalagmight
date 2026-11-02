import { test, expect, type Page } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  waitForNoDialogs,
  seedProjectWithSections,
  createSectionViaStore,
  waitForDrawnShots,
  getDrawnGeometry,
  readCanvasPixel,
  countCanvasInk,
  type SectionSeed,
  type ScreenPoint,
} from './helpers/app';

/**
 * WebGL context loss (#576 D38). A GPU reset, driver crash, some sleep/resume
 * cycles or WebKit memory pressure lose the map's WebGL context. MapLibre then
 * drops every custom layer and, on restore, re-applies only a serialized style
 * that skips them, so the survey (drawn entirely by custom layers) vanished until
 * the map was remounted. The app now re-adds them itself.
 *
 * Chromium exposes WEBGL_lose_context, which forces exactly that loss + restore.
 * The oracle is the painted pixel: the custom layers have no MapLibre features.
 *
 * The Global View's survey layer comes back the same way, and a context that is
 * lost and NOT restored (WebKit may give up on it) is reported after ~5 s with
 * a toast whose "Reload map" rebuilds the map on a new context; the toast clears
 * itself if the context comes back after all (decided D38-LOST).
 */

const seeds: SectionSeed[] = [
  {
    name: 'CaveA Main',
    direction: 'in',
    shots: [
      { azimuth_in: 90, azimuth_out: 270, length: 10, depth_in: -1, depth_out: -3 },
      { azimuth_in: 90, azimuth_out: 270, length: 10, depth_in: -3, depth_out: -6 },
      { azimuth_in: 90, azimuth_out: 270, length: 10, depth_in: -6, depth_out: -4 },
    ],
  },
];

const CUSTOM_LAYERS = ['survey-custom-render', 'survey-custom-labels'] as const;

async function openSeededAndZoom(page: Page, name: string): Promise<void> {
  await setupMockedPage(page);
  await createProject(page, name);
  await waitForNoDialogs(page);
  await seedProjectWithSections(page, seeds);
  await waitForDrawnShots(page, 3);
  // Spread the stations out so a shot midpoint is a few px of line, not a smear.
  await page.evaluate(() => {
    const w = window as unknown as {
      __stalagmight_map__: { jumpTo: (o: { center: [number, number]; zoom: number }) => void; getZoom: () => number };
      __stalagmight_geometry__: () => { stations: Array<{ lngLat: [number, number] }> };
    };
    const g = w.__stalagmight_geometry__();
    const lng = g.stations.reduce((s, x) => s + x.lngLat[0], 0) / g.stations.length;
    const lat = g.stations.reduce((s, x) => s + x.lngLat[1], 0) / g.stations.length;
    w.__stalagmight_map__.jumpTo({ center: [lng, lat], zoom: w.__stalagmight_map__.getZoom() + 3 });
  });
}

/** Total ink in small blocks around `points`, against the canvas-corner background. */
async function inkAt(page: Page, points: ScreenPoint[]): Promise<number> {
  const bg = await readCanvasPixel(page, 6, 6);
  let total = 0;
  for (const p of points) total += await countCanvasInk(page, p.x, p.y, bg, 9);
  return total;
}

/**
 * Page errors, plus any custom layer declaring itself dead: a frame drawn as the
 * context goes reports CONTEXT_LOST_WEBGL, which is no reason to self-disable.
 */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.text().includes('self-disabling')) errors.push(m.text());
  });
  return errors;
}

async function shotMidpoints(page: Page): Promise<ScreenPoint[]> {
  return (await getDrawnGeometry(page)).shots.map((s) => s.mid);
}

/** The map's layer ids, bottom to top. */
async function layerOrder(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __stalagmight_map__: { getLayersOrder: () => string[] } }).__stalagmight_map__.getLayersOrder(),
  );
}

/** The window handle of the map under test: the survey map or the Global View's. */
type MapHandle = '__stalagmight_map__' | '__stalagmight_global_map__';

async function loseContext(page: Page, handle: MapHandle = '__stalagmight_map__'): Promise<void> {
  await page.evaluate(async (handle) => {
    const w = window as unknown as Record<string, unknown> & { __e2eLoseContext__?: WEBGL_lose_context };
    const map = w[handle] as { getCanvas: () => HTMLCanvasElement; once: (e: string, cb: () => void) => void };
    const ext = map.getCanvas().getContext('webgl2')!.getExtension('WEBGL_lose_context')!;
    w.__e2eLoseContext__ = ext;
    const lost = new Promise((resolve) => map.once('webglcontextlost', () => resolve(null)));
    ext.loseContext();
    await lost;
  }, handle);
}

async function restoreContext(page: Page, handle: MapHandle = '__stalagmight_map__'): Promise<void> {
  await page.evaluate(async (handle) => {
    const w = window as unknown as Record<string, unknown> & { __e2eLoseContext__: WEBGL_lose_context };
    const map = w[handle] as { once: (e: string, cb: () => void) => void };
    const restored = new Promise((resolve) => map.once('webglcontextrestored', () => resolve(null)));
    w.__e2eLoseContext__.restoreContext();
    await restored;
  }, handle);
}

/** Tag the current map object, to tell a rebuilt map from the old one. */
async function tagMap(page: Page, handle: MapHandle): Promise<void> {
  await page.evaluate((handle) => {
    ((window as unknown as Record<string, unknown>)[handle] as Record<string, unknown>).__e2eTag__ = true;
  }, handle);
}

async function mapIsRebuilt(page: Page, handle: MapHandle): Promise<boolean> {
  return page.evaluate((handle) => {
    const map = (window as unknown as Record<string, unknown>)[handle] as Record<string, unknown> | undefined;
    return Boolean(map) && map!.__e2eTag__ !== true;
  }, handle);
}

const LOST_TOAST = '[data-testid="toast"][data-toast-key="render-context-lost"]:not([data-toast-leaving])';

async function openGlobalViewMap(page: Page): Promise<void> {
  await setupMockedPage(page);
  await expect(page.getByTestId('global-view')).toBeVisible({ timeout: 10000 });
  await page.locator('[data-testid="globalview-view-toggle-map"]').click();
  await expect(page.getByTestId('globalview-map')).toBeVisible({ timeout: 5000 });
  await expect.poll(() => globalLayerOrder(page)).toContain('global-survey-custom');
}

async function globalLayerOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const map = (window as unknown as { __stalagmight_global_map__?: { getLayersOrder: () => string[] } }).__stalagmight_global_map__;
    try {
      return map?.getLayersOrder() ?? [];
    } catch {
      return []; // no style while the context is lost
    }
  });
}

test.describe('Map survives a WebGL context loss', () => {
  test('survey geometry and labels come back, in their old stacking order', async ({ page }) => {
    const errors = collectErrors(page);
    await openSeededAndZoom(page, 'Context Loss Restore');

    const mids = await shotMidpoints(page);
    await expect.poll(() => inkAt(page, mids)).toBeGreaterThan(0);
    const orderBefore = await layerOrder(page);
    for (const id of CUSTOM_LAYERS) expect(orderBefore).toContain(id);

    await loseContext(page);
    await restoreContext(page);

    await expect
      .poll(async () => (await layerOrder(page)).filter((id) => (CUSTOM_LAYERS as readonly string[]).includes(id)))
      .toEqual(orderBefore.filter((id) => (CUSTOM_LAYERS as readonly string[]).includes(id)));
    // Same stack as before the loss, custom layers at their old positions.
    expect(await layerOrder(page)).toEqual(orderBefore);
    await expect.poll(() => inkAt(page, mids), { timeout: 10000 }).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test('an edit made while the context is lost is drawn after the restore', async ({ page }) => {
    const errors = collectErrors(page);
    await openSeededAndZoom(page, 'Context Loss Edit');

    await loseContext(page);
    // Longer than the seeded section, so its far end is drawn nowhere else.
    await createSectionViaStore(page, {
      name: 'CaveA Extension',
      direction: 'in',
      shots: Array.from({ length: 6 }, () => ({
        azimuth_in: 90, azimuth_out: 270, length: 10, depth_in: -1, depth_out: -2,
      })),
    });
    await restoreContext(page);

    await expect
      .poll(async () => (await getDrawnGeometry(page)).stations.filter((s) => s.stationIndex === 6).length)
      .toBe(1);
    const farEnd = (await getDrawnGeometry(page)).stations.find((s) => s.stationIndex === 6)!;
    await expect.poll(() => inkAt(page, [farEnd]), { timeout: 10000 }).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});

test.describe('Global View survives a WebGL context loss (#576 D38)', () => {
  test('the global survey layer comes back, in its old stacking order', async ({ page }) => {
    const errors = collectErrors(page);
    await openGlobalViewMap(page);
    const orderBefore = await globalLayerOrder(page);

    await loseContext(page, '__stalagmight_global_map__');
    await restoreContext(page, '__stalagmight_global_map__');

    await expect.poll(() => globalLayerOrder(page)).toEqual(orderBefore);
    expect(errors).toEqual([]);
  });
});

test.describe('A WebGL context that does not come back (#576 D38-LOST)', () => {
  test('survey map: after ~5 s a toast offers Reload map, which rebuilds the map on a new context', async ({ page }) => {
    const errors = collectErrors(page);
    await openSeededAndZoom(page, 'Context Lost For Good');
    await tagMap(page, '__stalagmight_map__');

    await loseContext(page);
    const toast = page.locator(LOST_TOAST);
    await expect(toast).toBeVisible({ timeout: 10000 });
    await expect(toast).toContainText('Survey rendering unavailable (WebGL2/GPU)');

    await toast.getByTestId('map-context-lost-reload').click();
    await expect.poll(() => mapIsRebuilt(page, '__stalagmight_map__'), { timeout: 10000 }).toBe(true);
    await expect(page.locator(LOST_TOAST)).toHaveCount(0);
    await waitForDrawnShots(page, 3);
    const order = await layerOrder(page);
    for (const id of CUSTOM_LAYERS) expect(order).toContain(id);
    await expect.poll(async () => inkAt(page, await shotMidpoints(page)), { timeout: 10000 }).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test('survey map: the toast clears itself when the context comes back after all', async ({ page }) => {
    const errors = collectErrors(page);
    await openSeededAndZoom(page, 'Context Back Late');

    await loseContext(page);
    await expect(page.locator(LOST_TOAST)).toBeVisible({ timeout: 10000 });
    await restoreContext(page);
    await expect(page.locator(LOST_TOAST)).toHaveCount(0);
    await expect.poll(async () => inkAt(page, await shotMidpoints(page)), { timeout: 10000 }).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test('Global View: the same toast rebuilds the Global View map', async ({ page }) => {
    const errors = collectErrors(page);
    await openGlobalViewMap(page);
    await tagMap(page, '__stalagmight_global_map__');

    await loseContext(page, '__stalagmight_global_map__');
    const toast = page.locator(LOST_TOAST);
    await expect(toast).toBeVisible({ timeout: 10000 });
    await toast.getByTestId('map-context-lost-reload').click();
    await expect.poll(() => mapIsRebuilt(page, '__stalagmight_global_map__'), { timeout: 10000 }).toBe(true);
    await expect(page.locator(LOST_TOAST)).toHaveCount(0);
    await expect.poll(() => globalLayerOrder(page)).toContain('global-survey-custom');
    expect(errors).toEqual([]);
  });
});
