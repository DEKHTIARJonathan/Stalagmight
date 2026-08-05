import { test, expect, type Page } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapReady,
  waitForMapIdle,
  waitForNoDialogs,
  waitForActiveTool,
  waitForDrawnStations,
  getDragGhostState,
  getDrawnGeometry,
  type ScreenPoint,
  type SectionSeed,
} from './helpers/app';

/**
 * #409 - the map is manipulated directly, the way every other map is: a plain
 * left-drag pans it under EVERY tool, and the Pan/Zoom tools are off the toolbar
 * unless the user opts back in.
 *
 * NO `seedNavigationTools` anywhere in this file, deliberately: this is the
 * default install, which is the configuration the whole feature is about.
 *
 * The gestures that take the left button back are covered elsewhere (the zoom
 * tool in zoom-tool.spec.ts, placement in placement-overlay.spec.ts); the one
 * exception asserted here is a move ghost in flight, because it is the only one
 * reachable without turning a setting on.
 */

const sectionSeeds: SectionSeed[] = [
  {
    name: 'Direct Manipulation Main',
    direction: 'in',
    shots: [
      { azimuth_in: 45, azimuth_out: 225, length: 10, depth_in: -1, depth_out: -2 },
      { azimuth_in: 90, azimuth_out: 270, length: 15, depth_in: -2, depth_out: -3 },
      { azimuth_in: 135, azimuth_out: 315, length: 12, depth_in: -3, depth_out: -4 },
    ],
  },
];

interface MapCenter {
  lng: number;
  lat: number;
}

async function getMapCenter(page: Page): Promise<MapCenter> {
  const center = await page.evaluate(() => {
    const map = (window as unknown as {
      __stalagmight_map__?: { getCenter: () => { lng: number; lat: number } };
    }).__stalagmight_map__;
    if (!map) return null;
    const c = map.getCenter();
    return { lng: c.lng, lat: c.lat };
  });
  expect(center, 'map instance is available').not.toBeNull();
  return center!;
}

async function getMapZoom(page: Page): Promise<number> {
  const zoom = await page.evaluate(() => {
    const map = (window as unknown as { __stalagmight_map__?: { getZoom: () => number } })
      .__stalagmight_map__;
    return map?.getZoom() ?? null;
  });
  expect(zoom, 'map instance is available').not.toBeNull();
  return zoom!;
}

/** Manhattan distance between two centers - "did the camera move at all". */
function centerDelta(a: MapCenter, b: MapCenter): number {
  return Math.abs(a.lng - b.lng) + Math.abs(a.lat - b.lat);
}

async function getSelection(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __E2E_TEST__?: { uiStore: { getState: () => { selection: unknown } } };
    }).__E2E_TEST__;
    return stores?.uiStore.getState().selection ?? null;
  });
}

/** The ruler's first endpoint and the merge tool's first pick, in one read. */
async function getToolPicks(page: Page): Promise<{ measureStart: unknown; mergeStationA: unknown }> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: { getState: () => { measureStart: unknown; mergeStationA: unknown } };
      };
    }).__E2E_TEST__;
    const state = stores?.uiStore.getState();
    return {
      measureStart: state?.measureStart ?? null,
      mergeStationA: state?.mergeStationA ?? null,
    };
  });
}

/** The map canvas's own bounding box - `map.project()` is canvas-relative. */
async function canvasBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator('canvas.maplibregl-canvas').boundingBox();
  expect(box, 'map canvas has a bounding box').not.toBeNull();
  return box!;
}

/**
 * Centre the camera on the seeded survey and zoom in, so the stations are tens
 * of pixels apart rather than a smear (the mock lays them out 10 m apart, which
 * at the fit-to-bounds zoom is a handful of pixels). `jumpTo` is not animated, so
 * positions read afterwards already match the new view.
 */
async function zoomInOnSurvey(page: Page, zoomDelta = 3): Promise<void> {
  await page.evaluate((dz) => {
    const w = window as unknown as {
      __stalagmight_map__?: {
        jumpTo: (opts: { center: [number, number]; zoom: number }) => void;
        getZoom: () => number;
      };
      __stalagmight_geometry__?: () => { stations: Array<{ lngLat: [number, number] }> } | null;
    };
    const map = w.__stalagmight_map__;
    const geometry = w.__stalagmight_geometry__?.();
    if (!map || !geometry || geometry.stations.length === 0) {
      throw new Error('map + drawn geometry must be ready before zooming');
    }
    const count = geometry.stations.length;
    const lng = geometry.stations.reduce((sum, s) => sum + s.lngLat[0], 0) / count;
    const lat = geometry.stations.reduce((sum, s) => sum + s.lngLat[1], 0) / count;
    map.jumpTo({ center: [lng, lat], zoom: map.getZoom() + dz });
  }, zoomDelta);
}

/**
 * Keep-out band around the canvas edges. The map canvas runs edge to edge under
 * FLOATING chrome - the two panel-reveal handles, the +/- zoom buttons, the
 * scale bar, the "Data" tab - and a PRESS that lands on one of those never
 * reaches MapLibre, so it starts no drag at all. (The release half used to hang
 * the drag handler too; that is fixed - see "releasing a drag over floating
 * chrome" below - but the inset stays: these gestures want clear canvas at both
 * ends so they exercise the map and nothing else.)
 */
const EDGE_INSET = 70;

/** Distance from `p` to the segment `a`-`b`. */
function pointToSegment(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const lengthSq = vx * vx + vy * vy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/**
 * A canvas point at least `clearance` px from every drawn station and shot -
 * "empty map", so a click or a drag there cannot resolve to a feature.
 *
 * `delta`, when given, is the gesture that will start there: only candidates
 * whose END point is also clear of the edge chrome are considered. Scans a
 * coarse grid and takes the point FARTHEST from the survey, which keeps the
 * choice deterministic for a given camera.
 */
async function findEmptyPoint(
  page: Page,
  delta: { dx: number; dy: number } = { dx: 0, dy: 0 },
  clearance = 80
): Promise<ScreenPoint> {
  const box = await canvasBox(page);
  const { stations, shots } = await getDrawnGeometry(page);
  const inside = (p: ScreenPoint): boolean =>
    p.x >= EDGE_INSET &&
    p.y >= EDGE_INSET &&
    p.x <= box.width - EDGE_INSET &&
    p.y <= box.height - EDGE_INSET;

  let best: ScreenPoint | null = null;
  let bestClearance = -Infinity;
  for (let fx = 0.05; fx <= 0.9501; fx += 0.05) {
    for (let fy = 0.05; fy <= 0.9501; fy += 0.05) {
      const candidate = { x: box.width * fx, y: box.height * fy };
      if (!inside(candidate)) continue;
      if (!inside({ x: candidate.x + delta.dx, y: candidate.y + delta.dy })) continue;
      let nearest = Infinity;
      for (const s of stations) {
        nearest = Math.min(nearest, Math.hypot(candidate.x - s.x, candidate.y - s.y));
      }
      for (const sh of shots) {
        nearest = Math.min(nearest, pointToSegment(candidate, sh.from, sh.to));
      }
      if (nearest > bestClearance) {
        bestClearance = nearest;
        best = candidate;
      }
    }
  }
  expect(best, 'a candidate point clear of the edge chrome exists').not.toBeNull();
  expect(
    bestClearance,
    `an empty map point at least ${clearance}px from the survey exists`
  ).toBeGreaterThan(clearance);
  return best!;
}

/** The station farthest from every OTHER station - a click on it is unambiguous. */
async function mostIsolatedStation(page: Page): Promise<{
  x: number;
  y: number;
  sectionId: number;
  stationIndex: number;
}> {
  const stations = await waitForDrawnStations(page, 2);
  let best = stations[0]!;
  let bestMinOther = -Infinity;
  for (const candidate of stations) {
    let minOther = Infinity;
    for (const other of stations) {
      if (other === candidate) continue;
      minOther = Math.min(minOther, Math.hypot(candidate.x - other.x, candidate.y - other.y));
    }
    if (minOther > bestMinOther) {
      bestMinOther = minOther;
      best = candidate;
    }
  }
  return best;
}

/**
 * Left-drag from one canvas point to another (canvas-relative coordinates).
 * Both ends are checked against EDGE_INSET first: a gesture that strays onto the
 * floating chrome fails here, with a message, instead of hanging the next
 * `waitForMapIdle` on a drag MapLibre was never told had ended.
 */
async function dragOnCanvas(page: Page, from: ScreenPoint, to: ScreenPoint): Promise<void> {
  const box = await canvasBox(page);
  for (const [name, p] of [['start', from], ['end', to]] as const) {
    expect(p.x, `drag ${name} x is clear of the canvas chrome`).toBeGreaterThanOrEqual(EDGE_INSET);
    expect(p.y, `drag ${name} y is clear of the canvas chrome`).toBeGreaterThanOrEqual(EDGE_INSET);
    expect(p.x, `drag ${name} x is clear of the canvas chrome`).toBeLessThanOrEqual(
      box.width - EDGE_INSET
    );
    expect(p.y, `drag ${name} y is clear of the canvas chrome`).toBeLessThanOrEqual(
      box.height - EDGE_INSET
    );
  }
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 10 });
  await page.mouse.up();
}

async function setUpSurvey(page: Page): Promise<void> {
  await createProject(page, 'Direct Manipulation');
  await seedProjectWithSections(page, sectionSeeds);
  await waitForMapReady(page);
  await waitForNoDialogs(page);
  await waitForMapIdle(page);
  await waitForDrawnStations(page, 2);
  await zoomInOnSurvey(page);
  await waitForMapIdle(page);
  await waitForDrawnStations(page, 2);
}

test.describe('Map direct manipulation (#409)', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await setUpSurvey(page);
  });

  test('a plain left-drag on empty map pans under the default tool @smoke', async ({ page }) => {
    await waitForActiveTool(page, 'select');

    const selectionBefore = await getSelection(page);
    const centerBefore = await getMapCenter(page);
    const empty = await findEmptyPoint(page, { dx: 120, dy: 90 });

    await dragOnCanvas(page, empty, { x: empty.x + 120, y: empty.y + 90 });
    await waitForMapIdle(page);

    expect(centerDelta(await getMapCenter(page), centerBefore)).toBeGreaterThan(0.00001);
    // Panning is navigation, not selection.
    expect(await getSelection(page)).toEqual(selectionBefore);
    await waitForActiveTool(page, 'select');
  });

  test('a drag that STARTS on a station pans, and does not select it', async ({ page }) => {
    await waitForActiveTool(page, 'select');

    const station = await mostIsolatedStation(page);
    const centerBefore = await getMapCenter(page);

    await dragOnCanvas(page, station, { x: station.x + 130, y: station.y + 60 });
    await waitForMapIdle(page);

    expect(centerDelta(await getMapCenter(page), centerBefore)).toBeGreaterThan(0.00001);
    // The press landed on a feature, but the gesture was a drag - MapLibre's
    // clickTolerance is what keeps it from also being a click.
    expect(await getSelection(page)).toBeNull();
  });

  test('a plain click after a drag still selects a station', async ({ page }) => {
    await waitForActiveTool(page, 'select');

    // Pan first, so the click below is exercised on a camera that just moved -
    // the clickTolerance path has to survive that, not only a pristine map.
    const empty = await findEmptyPoint(page, { dx: 100, dy: 70 });
    await dragOnCanvas(page, empty, { x: empty.x + 100, y: empty.y + 70 });
    await waitForMapIdle(page);
    expect(await getSelection(page)).toBeNull();

    // Positions moved with the camera, so re-read them.
    const station = await mostIsolatedStation(page);
    const box = await canvasBox(page);
    await page.mouse.click(box.x + station.x, box.y + station.y);

    await expect.poll(() => getSelection(page)).toEqual({
      type: 'station',
      stationRef: { section_id: station.sectionId, station_index: station.stationIndex },
    });
  });

  for (const tool of [
    { key: 'r', name: 'measure' },
    { key: 'm', name: 'merge' },
  ]) {
    test(`a drag under ${tool.name} pans and starts no ${tool.name} interaction`, async ({ page }) => {
      await page.keyboard.press(tool.key);
      await waitForActiveTool(page, tool.name);

      const centerBefore = await getMapCenter(page);
      // Start ON a station: the tools pick stations, so this is the drag that
      // could most plausibly be mistaken for the first half of a pick.
      const station = await mostIsolatedStation(page);

      await dragOnCanvas(page, station, { x: station.x + 140, y: station.y + 70 });
      await waitForMapIdle(page);

      expect(centerDelta(await getMapCenter(page), centerBefore)).toBeGreaterThan(0.00001);

      const picks = await getToolPicks(page);
      expect(picks.measureStart, 'no ruler endpoint was placed').toBeNull();
      expect(picks.mergeStationA, 'no merge station was picked').toBeNull();
      // The tool is still the tool - panning is not a mode switch.
      await waitForActiveTool(page, tool.name);
    });
  }

  test('no box-select overlay is drawn by a drag past the click tolerance', async ({ page }) => {
    await waitForActiveTool(page, 'select');

    const empty = await findEmptyPoint(page, { dx: 60, dy: 45 });
    const box = await canvasBox(page);
    const overlay = page.getByTestId('box-select-overlay');

    await page.mouse.move(box.x + empty.x, box.y + empty.y);
    await page.mouse.down();
    // Well past MapLibre's 3px clickTolerance, which is where a box select used
    // to appear. Asserted MID-DRAG: the overlay only ever existed while the
    // button was down.
    await page.mouse.move(box.x + empty.x + 60, box.y + empty.y + 45, { steps: 6 });
    await expect(overlay).toHaveCount(0);

    await page.mouse.up();
    await waitForMapIdle(page);
    await expect(overlay).toHaveCount(0);
  });

  test('P and Z are inert and the navigate group is not on the toolbar', async ({ page }) => {
    const mapCanvas = page.getByTestId('map-canvas');
    await waitForActiveTool(page, 'select');

    await expect(page.getByTestId('tool-group-navigate')).toHaveCount(0);

    await page.keyboard.press('p');
    await page.keyboard.press('z');
    // A settle rather than a poll: this proves the tool does NOT change, and a
    // poll would accept the pre-update value.
    await page.waitForTimeout(200);
    await expect(mapCanvas).toHaveAttribute('data-active-tool', 'select');
  });

  test('double-click zooms in', async ({ page }) => {
    await waitForActiveTool(page, 'select');

    const zoomBefore = await getMapZoom(page);
    const empty = await findEmptyPoint(page);
    const box = await canvasBox(page);

    await page.mouse.dblclick(box.x + empty.x, box.y + empty.y);
    await page.waitForFunction((z) => {
      const map = (window as unknown as {
        __stalagmight_map__?: { getZoom: () => number; isMoving: () => boolean };
      }).__stalagmight_map__;
      return Boolean(map && !map.isMoving() && map.getZoom() > z);
    }, zoomBefore, { timeout: 5000 });

    expect(await getMapZoom(page)).toBeGreaterThan(zoomBefore);
  });

  test('a right-click after a drag still opens the feature context menu', async ({ page }) => {
    await waitForActiveTool(page, 'select');

    const empty = await findEmptyPoint(page, { dx: 110, dy: 80 });
    await dragOnCanvas(page, empty, { x: empty.x + 110, y: empty.y + 80 });
    await waitForMapIdle(page);

    // Re-read: the drag moved the camera under the features.
    const station = await mostIsolatedStation(page);
    const box = await canvasBox(page);
    await page.mouse.click(box.x + station.x, box.y + station.y, { button: 'right' });

    await expect(page.getByTestId('context-menu')).toBeVisible({ timeout: 5000 });
  });

  test('Move Station: a drag pans, unless a ghost is already in flight', async ({ page }) => {
    await page.keyboard.press('t');
    await waitForActiveTool(page, 'move_station');

    // Not carrying: the drag belongs to the map.
    const centerBeforePan = await getMapCenter(page);
    const empty = await findEmptyPoint(page, { dx: 120, dy: 80 });
    await dragOnCanvas(page, empty, { x: empty.x + 120, y: empty.y + 80 });
    await waitForMapIdle(page);
    expect(centerDelta(await getMapCenter(page), centerBeforePan)).toBeGreaterThan(0.00001);

    // Grab a station. The move tools grab and drop on CLICKS, so this picks the
    // ghost up rather than starting a button-held drag.
    const station = await mostIsolatedStation(page);
    const box = await canvasBox(page);
    await page.mouse.click(box.x + station.x, box.y + station.y);
    await expect.poll(() => getDragGhostState(page), { timeout: 5000 }).not.toBeNull();

    // Carrying: the drag belongs to the ghost, which drops on pointerup -
    // something clickTolerance does not gate - so the map must not pan under it.
    const centerCarrying = await getMapCenter(page);
    await dragOnCanvas(page, { x: station.x, y: station.y }, { x: station.x + 120, y: station.y + 80 });
    // Settle: proving the camera did NOT move, so a poll would accept the
    // pre-update value.
    await page.waitForTimeout(200);
    expect(centerDelta(await getMapCenter(page), centerCarrying)).toBe(0);

    // Leave the ghost behind rather than committing a move the next test would
    // have to know about.
    await page.keyboard.press('Escape');
  });

  test('releasing a drag over floating chrome still ends the drag', async ({ page }) => {
    await waitForActiveTool(page, 'select');

    const zoomIn = page.locator('.maplibregl-ctrl-zoom-in');
    await expect(zoomIn).toBeVisible();
    const button = await zoomIn.boundingBox();
    expect(button, 'the zoom-in control has a bounding box').not.toBeNull();
    const release = {
      x: button!.x + button!.width / 2,
      y: button!.y + button!.height / 2,
    };

    const box = await canvasBox(page);
    const centerBefore = await getMapCenter(page);
    const zoomBefore = await getMapZoom(page);
    // Two legs: the first stays on clear canvas, so the camera provably moves;
    // the second carries the still-pressed button off the canvas and onto the
    // zoom control, which is where the release happens.
    const start = await findEmptyPoint(page, { dx: 120, dy: 90 });

    await page.mouse.move(box.x + start.x, box.y + start.y);
    await page.mouse.down();
    await page.mouse.move(box.x + start.x + 120, box.y + start.y + 90, { steps: 10 });
    await page.mouse.move(release.x, release.y, { steps: 10 });
    await page.mouse.up();

    // LOAD-BEARING: nothing may move the mouse from here on. MapLibre's drag
    // handler listens for mousemove on the document, so ANY later movement ends
    // the wedged drag by itself and makes this test vacuous. Every assertion
    // below reads state through page.evaluate only.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const map = (window as unknown as {
              __stalagmight_map__?: { isMoving: () => boolean };
            }).__stalagmight_map__;
            return map ? map.isMoving() : null;
          }),
        { message: 'the drag ended even though the release landed on the zoom control' }
      )
      .toBe(false);

    // ...and it really was a drag, not a gesture that trivially had nothing to end.
    expect(centerDelta(await getMapCenter(page), centerBefore)).toBeGreaterThan(0.00001);
    // The release must not press the button underneath it: the browser fires
    // `click` on the common ancestor of the press and release targets, which is
    // the map container, not the control.
    expect(await getMapZoom(page)).toBeCloseTo(zoomBefore, 6);
  });
});
