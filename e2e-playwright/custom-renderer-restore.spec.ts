import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapReady,
  waitForDrawnStations,
  getDrawnGeometry,
  readCanvasPixel,
  countCanvasInk,
  type SectionSeed,
} from './helpers/app';

/**
 * MapLibre 6 rebuilds the style from `style.serialize()` after a WebGL context
 * loss and after a worker restart, and custom layers cannot be serialized, so
 * both paths drop every survey custom layer (#606). `styleRestore.ts` re-adds
 * them. Each test forces one restore path for real and requires the same custom
 * layers back, in the same order, and survey ink at a shot midpoint again.
 */

const sectionSeeds: SectionSeed[] = [
  {
    name: 'Restore Main',
    direction: 'in',
    shots: [
      { azimuth_in: 45, azimuth_out: 225, length: 10.5, depth_in: -2, depth_out: -2.5, left: 1.5, right: 2.3, up: 3.0, down: 0.8 },
      { azimuth_in: 90, azimuth_out: 270, length: 15.2, depth_in: -2.5, depth_out: -5.0, left: 0.5, right: 0.7, up: 1.2, down: 1.5 },
    ],
  },
];

type RestoreMap = {
  getLayersOrder: () => string[];
  getLayer: (id: string) => { type: string } | undefined;
  once: (ev: string, cb: () => void) => void;
  painter: { context: { gl: WebGL2RenderingContext } };
  _handleWorkersRestarted: () => void;
};

function customLayerOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const map = (window as unknown as { __stalagmight_map__?: RestoreMap }).__stalagmight_map__;
    if (!map) return [];
    return map.getLayersOrder().filter((id) => map.getLayer(id)?.type === 'custom');
  });
}

async function surveyInk(page: Page): Promise<number> {
  const geom = await getDrawnGeometry(page);
  const shot = geom.shots[Math.floor(geom.shots.length / 2)];
  if (!shot) return 0;
  const bg = await readCanvasPixel(page, 8, 8);
  return countCanvasInk(page, Math.round(shot.mid.x), Math.round(shot.mid.y), bg, 9);
}

async function bootSurvey(page: Page): Promise<string[]> {
  await setupMockedPage(page);
  await createProject(page, 'Restore');
  await seedProjectWithSections(page, sectionSeeds);
  await waitForMapReady(page);
  await waitForDrawnStations(page, 1);
  await expect.poll(() => surveyInk(page), { timeout: 10000 }).toBeGreaterThan(0);
  const before = await customLayerOrder(page);
  expect(before).toContain('survey-custom-render');
  return before;
}

async function expectRestored(page: Page, before: string[]): Promise<void> {
  await expect.poll(() => customLayerOrder(page), { timeout: 10000 }).toEqual(before);
  await expect.poll(() => surveyInk(page), { timeout: 10000 }).toBeGreaterThan(0);
}

test.describe('Custom renderer restore', () => {
  test('survey custom layers come back after a worker restart', async ({ page }) => {
    const before = await bootSurvey(page);
    await page.evaluate(() => {
      const map = (window as unknown as { __stalagmight_map__: RestoreMap }).__stalagmight_map__;
      map._handleWorkersRestarted();
    });
    await expectRestored(page, before);
  });

  test('survey custom layers come back after a WebGL context loss', async ({ page }) => {
    const before = await bootSurvey(page);
    const restored = await page.evaluate(async () => {
      const map = (window as unknown as { __stalagmight_map__: RestoreMap }).__stalagmight_map__;
      const ext = map.painter.context.gl.getExtension('WEBGL_lose_context');
      if (!ext) return false;
      const lost = new Promise<void>((resolve) => map.once('webglcontextlost', resolve));
      ext.loseContext();
      await lost;
      // Chromium allows restoreContext only once the lost event's dispatch,
      // whose preventDefault grants it, has finished.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const back = new Promise<void>((resolve) => map.once('webglcontextrestored', resolve));
      ext.restoreContext();
      await back;
      return true;
    });
    expect(restored, 'WEBGL_lose_context unavailable').toBe(true);
    await expectRestored(page, before);
  });
});
