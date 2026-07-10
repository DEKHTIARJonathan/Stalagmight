import { test, expect, Page } from './fixtures/coverage';
import { setupTauriMocks } from './mocks/tauri-ipc';
import { seedProjectWithSections, waitForMapReady, type SectionSeed } from './helpers/app';

/**
 * E2E for the dual-distance ruler/measure tool (#26): direct + along-cave-line
 * distance, shot tinting, and reset behavior. The mock returns a deterministic
 * along-line distance (12.34) and tints the first shots of the section.
 */

interface StationPosition {
  x: number;
  y: number;
}

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
    name: 'Ruler Main',
    direction: 'in',
    shots: [
      { azimuth_in: 90, azimuth_out: 90, length: 10, depth_in: -1, depth_out: -2, left: 1, right: 1, up: 1, down: 1 },
      { azimuth_in: 90, azimuth_out: 90, length: 10, depth_in: -2, depth_out: -3, left: 1, right: 1, up: 1, down: 1 },
      { azimuth_in: 90, azimuth_out: 90, length: 10, depth_in: -3, depth_out: -4, left: 1, right: 1, up: 1, down: 1 },
    ],
  },
];

// The visible survey-stations layer now returns MERGED MultiPoint features (one
// group per section/color, coordinates = an ARRAY of station points, and NO
// per-point stationIndex). Flatten every individual point to its screen position;
// distinct array indices resolve to distinct stations for the two-station measure
// flow (identity is discovered behaviorally by which station a click selects).
async function getStationScreenPositions(page: Page): Promise<StationPosition[]> {
  return page.evaluate(() => {
    const map = (window as unknown as {
      __stalagmight_map__?: {
        queryRenderedFeatures: (opts: { layers: string[] }) => Array<{
          geometry: { type: string; coordinates: number[] | number[][] };
        }>;
        project: (coords: [number, number]) => { x: number; y: number };
      };
    }).__stalagmight_map__;
    if (!map) return [];
    try {
      const features = map.queryRenderedFeatures({ layers: ['survey-stations'] });
      const out: StationPosition[] = [];
      for (const f of features) {
        const raw =
          f.geometry.type === 'MultiPoint'
            ? (f.geometry.coordinates as number[][])
            : [f.geometry.coordinates as number[]];
        for (const c of raw) {
          const screenPos = map.project([c[0]!, c[1]!]);
          out.push({ x: screenPos.x, y: screenPos.y });
        }
      }
      return out;
    } catch {
      return [];
    }
  });
}

async function activeTool(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const stores = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { activeTool: string } } } }).__E2E_TEST__;
    return stores?.uiStore?.getState()?.activeTool;
  });
}

/** Count distinct shots whose `measured` feature-state is set (the path tint).
 *  survey-data-shots is a VECTOR-TILE source now, so the query and every
 *  getFeatureState read must name the tile source-layer ('g'). */
async function countMeasuredShots(page: Page): Promise<number> {
  return page.evaluate(() => {
    const map = (window as unknown as {
      __stalagmight_map__?: {
        querySourceFeatures: (s: string, opts?: { sourceLayer?: string }) => Array<{ id?: number }>;
        getFeatureState: (f: { source: string; sourceLayer?: string; id: number }) => { measured?: boolean };
      };
    }).__stalagmight_map__;
    if (!map) return 0;
    const seen = new Set<number>();
    let n = 0;
    for (const f of map.querySourceFeatures('survey-data-shots', { sourceLayer: 'g' })) {
      if (f.id == null || seen.has(f.id)) continue;
      seen.add(f.id);
      if (map.getFeatureState({ source: 'survey-data-shots', sourceLayer: 'g', id: f.id })?.measured) n++;
    }
    return n;
  });
}

/** Count distinct stations whose `measured` feature-state is set (the path tint).
 *  survey-data-stations is a VECTOR-TILE source now, so the query and every
 *  getFeatureState read must name the tile source-layer ('g'). */
async function countMeasuredStations(page: Page): Promise<number> {
  return page.evaluate(() => {
    const map = (window as unknown as {
      __stalagmight_map__?: {
        querySourceFeatures: (s: string, opts?: { sourceLayer?: string }) => Array<{ id?: number }>;
        getFeatureState: (f: { source: string; sourceLayer?: string; id: number }) => { measured?: boolean };
      };
    }).__stalagmight_map__;
    if (!map) return 0;
    const seen = new Set<number>();
    let n = 0;
    for (const f of map.querySourceFeatures('survey-data-stations', { sourceLayer: 'g' })) {
      if (f.id == null || seen.has(f.id)) continue;
      seen.add(f.id);
      if (map.getFeatureState({ source: 'survey-data-stations', sourceLayer: 'g', id: f.id })?.measured) n++;
    }
    return n;
  });
}

async function shotsLineColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const map = (window as unknown as { __stalagmight_map__?: { getPaintProperty: (l: string, p: string) => unknown } }).__stalagmight_map__;
    return map ? JSON.stringify(map.getPaintProperty('survey-shots', 'line-color')) : '';
  });
}

async function clickStation(page: Page, index: number): Promise<void> {
  const stations = await getStationScreenPositions(page);
  const target = stations[index];
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box || !target) throw new Error('no canvas/station');
  await page.mouse.move(box.x + target.x, box.y + target.y);
  await page.mouse.click(box.x + target.x, box.y + target.y);
}

test.describe('Measure tool — dual distance + tint (#26)', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await createProject(page, 'Ruler Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapReady(page);
    await expect.poll(async () => (await getStationScreenPositions(page)).length, { timeout: 10000 }).toBeGreaterThan(1);
    await page.keyboard.press('r');
    await expect.poll(() => activeTool(page), { timeout: 2000 }).toBe('measure');
  });

  test('shows both direct and along-line distance between two stations', async ({ page }) => {
    await clickStation(page, 0);
    await clickStation(page, 1);

    await expect(page.locator('[data-testid="measure-readout"]')).toBeVisible();
    await expect(page.locator('[data-testid="measure-direct"]')).toContainText('m');
    // Along-line resolves to the mocked value.
    await expect(page.locator('[data-testid="measure-along-line"]')).toContainText('12.3');
    await expect(page.locator('[data-testid="measure-depth-diff"]')).toContainText('m');
  });

  test('tints the path shots and stations, and clears them on Escape', async ({ page }) => {
    await clickStation(page, 0);
    await clickStation(page, 1);
    await expect(page.locator('[data-testid="measure-along-line"]')).toContainText('12.3');

    // The shots line-color expression references the measured feature-state, and
    // both at least one shot AND at least one station are tinted (#26).
    await expect.poll(() => shotsLineColor(page)).toContain('measured');
    await expect.poll(() => countMeasuredShots(page)).toBeGreaterThan(0);
    await expect.poll(() => countMeasuredStations(page)).toBeGreaterThan(0);

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="measure-readout"]')).toHaveCount(0);
    await expect.poll(() => countMeasuredShots(page)).toBe(0);
    await expect.poll(() => countMeasuredStations(page)).toBe(0);
  });

  test('readout persists past the old 5-second auto-clear', async ({ page }) => {
    await clickStation(page, 0);
    await clickStation(page, 1);
    await expect(page.locator('[data-testid="measure-readout"]')).toBeVisible();
    await page.waitForTimeout(5500);
    await expect(page.locator('[data-testid="measure-readout"]')).toBeVisible();
  });

  test('switching to another tool resets the measurement + tint', async ({ page }) => {
    await clickStation(page, 0);
    await clickStation(page, 1);
    await expect(page.locator('[data-testid="measure-readout"]')).toBeVisible();
    await expect.poll(() => countMeasuredShots(page)).toBeGreaterThan(0);

    await page.keyboard.press('s'); // select tool
    await expect.poll(() => activeTool(page)).toBe('select');
    await expect(page.locator('[data-testid="measure-readout"]')).toHaveCount(0);
    await expect.poll(() => countMeasuredShots(page)).toBe(0);
  });

  test('a click on a completed measurement resets and restarts', async ({ page }) => {
    await clickStation(page, 0);
    await clickStation(page, 1);
    await expect(page.locator('[data-testid="measure-readout"]')).toBeVisible();

    // A third click clears the old readout and becomes the new first point.
    await clickStation(page, 2);
    await expect(page.locator('[data-testid="measure-readout"]')).toHaveCount(0);
    // Finishing again shows a fresh readout.
    await clickStation(page, 0);
    await expect(page.locator('[data-testid="measure-readout"]')).toBeVisible();
  });
});
