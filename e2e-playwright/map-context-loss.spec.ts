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

async function loseContext(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as {
      __stalagmight_map__: { getCanvas: () => HTMLCanvasElement; once: (e: string, cb: () => void) => void };
      __e2eLoseContext__?: WEBGL_lose_context;
    };
    const map = w.__stalagmight_map__;
    const ext = map.getCanvas().getContext('webgl2')!.getExtension('WEBGL_lose_context')!;
    w.__e2eLoseContext__ = ext;
    const lost = new Promise((resolve) => map.once('webglcontextlost', () => resolve(null)));
    ext.loseContext();
    await lost;
  });
}

async function restoreContext(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as {
      __stalagmight_map__: { once: (e: string, cb: () => void) => void };
      __e2eLoseContext__: WEBGL_lose_context;
    };
    const restored = new Promise((resolve) => w.__stalagmight_map__.once('webglcontextrestored', () => resolve(null)));
    w.__e2eLoseContext__.restoreContext();
    await restored;
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
