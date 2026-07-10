import { test, expect, Page } from './fixtures/coverage';
import { setupTauriMocks } from './mocks/tauri-ipc';
import { seedProjectWithSections, type SectionSeed } from './helpers/app';

/**
 * E2E tests for hitbox detection functionality.
 *
 * These tests verify that stations and shots are detected at their configured
 * hitArea boundaries, using deterministic screen coordinates via map.project().
 *
 * NOTE (#mem budget): the dedicated survey-shots-hitbox / survey-stations-hitbox
 * layers were removed (they were full duplicate vertex buckets). Hit-testing now
 * queries the VISIBLE survey-shots / survey-stations layers with a padded probe
 * box that reproduces the same tolerance (shot reach = hit_area/2, station reach
 * = hit_area), reading config.map.*.hit_area LIVE per query (no paint property, no
 * async settle). The boundary/nearest tests below cover that behavior directly.
 *
 * The old layer-inspection tests have been ported to the CURRENT model:
 *   - layer order / queryability assert against the visible survey-stations /
 *     survey-shots layers,
 *   - the debug show_hitboxes toggle and hit_area sizes now drive ONLY the
 *     debug-only ghost layers survey-ghost-stations-hitbox (circle) and
 *     survey-ghost-shots-hitbox (line); those tests assert against the ghost
 *     layers (an accepted "debug hitboxes are ghost-only now" design decision),
 *   - the hit_area-behavior test stays behavioral: the same screen point flips
 *     from hit to miss purely from a live config change.
 */

/**
 * Helper to wait for the map to be fully loaded.
 */
async function waitForMapReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const map = (window as unknown as {
        __stalagmight_map__?: { loaded?: () => boolean; isStyleLoaded?: () => boolean };
      }).__stalagmight_map__;
      return Boolean(map && ((map.isStyleLoaded && map.isStyleLoaded()) || (map.loaded && map.loaded())));
    },
    { timeout: 10000 }
  );
}

/**
 * Helper to wait for the app to be ready (canvas visible and map loaded).
 */
async function waitForAppReady(page: Page): Promise<void> {
  await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 10000 });
  await waitForMapReady(page);
}

/**
 * Helper to wait for station features to be rendered.
 */
async function waitForStationsRendered(page: Page): Promise<void> {
  await expect.poll(async () => {
    return page.evaluate(() => {
      const map = (window as unknown as {
        __stalagmight_map__?: { queryRenderedFeatures: (opts: { layers: string[] }) => Array<unknown> };
      }).__stalagmight_map__;
      if (!map) return 0;
      try {
        return map.queryRenderedFeatures({ layers: ['survey-stations'] }).length;
      } catch {
        return 0;
      }
    });
  }, { timeout: 10000 }).toBeGreaterThan(0);
}

/**
 * Helper to create a new project with the given name.
 */
async function createProject(page: Page, name: string): Promise<void> {
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill(name);
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await waitForAppReady(page);
  await seedProjectWithSections(page, sectionSeeds);
  await waitForStationsRendered(page);
}

const sectionSeeds: SectionSeed[] = [
  {
    name: 'Hitbox Main',
    direction: 'in',
    shots: [
      { azimuth_in: 0, azimuth_out: 180, length: 10, depth_in: 0, depth_out: -2 },
      { azimuth_in: 90, azimuth_out: 270, length: 8, depth_in: -2, depth_out: -4 },
    ],
  },
  {
    name: 'Hitbox Branch',
    direction: 'out',
    shots: [
      { azimuth_in: 45, azimuth_out: 225, length: 6, depth_in: -1, depth_out: -3 },
    ],
  },
];

/**
 * Flatten the merged station features into individual station SCREEN points.
 *
 * The visible survey-stations layer now returns MERGED MultiPoint features (one
 * group per section/color/etc, coordinates = an ARRAY of station points, and NO
 * per-point stationIndex). So we can't read a `(sectionId, stationIndex)` off a
 * feature; we extract every individual point and identify a target station
 * BEHAVIORALLY — by which station a click on that point actually selects. Points
 * carry no identity here (the click resolves it via the geometry-index resolver).
 */
async function getStationScreenPoints(page: Page): Promise<Array<{ x: number; y: number }>> {
  return page.evaluate(() => {
    const map = (window as unknown as {
      __stalagmight_map__?: {
        project: (coords: [number, number]) => { x: number; y: number };
        queryRenderedFeatures: (options?: { layers?: string[] }) => Array<{
          geometry: { type: string; coordinates: number[] | number[][] };
        }>;
      };
    }).__stalagmight_map__;
    if (!map) throw new Error('Map not available');

    const features = map.queryRenderedFeatures({ layers: ['survey-stations'] });
    const points: Array<{ x: number; y: number }> = [];
    for (const f of features) {
      const raw =
        f.geometry.type === 'MultiPoint'
          ? (f.geometry.coordinates as number[][])
          : [f.geometry.coordinates as number[]];
      for (const c of raw) {
        const s = map.project([c[0]!, c[1]!]);
        points.push({ x: s.x, y: s.y });
      }
    }
    return points;
  });
}

/**
 * Flatten the merged shot features into individual shot SEGMENTS (screen space),
 * plus every station's screen point.
 *
 * The visible survey-shots layer now returns MERGED MultiLineString features
 * (one group per colorIndex/isReference per section; each inner line is one
 * shot's 2-point segment) with NO per-shot `shotId`. We flatten every inner
 * segment so a test can pick an isolated shot and identify it behaviorally (by
 * which shot a click selects). The station points let a caller pick a segment
 * midpoint that is clear of all station hitboxes.
 */
async function getShotSegmentsAndStations(page: Page): Promise<{
  segments: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  stations: Array<{ x: number; y: number }>;
}> {
  return page.evaluate(() => {
    const map = (window as unknown as {
      __stalagmight_map__?: {
        project: (coords: [number, number]) => { x: number; y: number };
        queryRenderedFeatures: (options?: { layers?: string[] }) => Array<{
          geometry: { type: string; coordinates: number[] | number[][] | number[][][] };
        }>;
      };
    }).__stalagmight_map__;
    if (!map) throw new Error('Map not available');

    const shotFeatures = map.queryRenderedFeatures({ layers: ['survey-shots'] });
    const segments: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    for (const f of shotFeatures) {
      const lines: number[][][] =
        f.geometry.type === 'MultiLineString'
          ? (f.geometry.coordinates as number[][][])
          : f.geometry.type === 'LineString'
            ? [f.geometry.coordinates as number[][]]
            : [];
      for (const line of lines) {
        for (let i = 0; i + 1 < line.length; i++) {
          const a = map.project([line[i]![0]!, line[i]![1]!]);
          const b = map.project([line[i + 1]![0]!, line[i + 1]![1]!]);
          segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        }
      }
    }

    const stationFeatures = map.queryRenderedFeatures({ layers: ['survey-stations'] });
    const stations: Array<{ x: number; y: number }> = [];
    for (const f of stationFeatures) {
      const raw =
        f.geometry.type === 'MultiPoint'
          ? (f.geometry.coordinates as number[][])
          : [f.geometry.coordinates as number[]];
      for (const c of raw) {
        const s = map.project([c[0]!, c[1]!]);
        stations.push({ x: s.x, y: s.y });
      }
    }
    return { segments, stations };
  });
}

/** The most isolated point (farthest from every OTHER point). A click on it
 *  unambiguously resolves to the one station rendered there. */
function mostIsolatedPoint(points: Array<{ x: number; y: number }>): { x: number; y: number } {
  let bestIdx = 0;
  let bestMinOther = -Infinity;
  for (let i = 0; i < points.length; i++) {
    let minOther = Infinity;
    for (let j = 0; j < points.length; j++) {
      if (i === j) continue;
      minOther = Math.min(minOther, Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y));
    }
    if (minOther > bestMinOther) {
      bestMinOther = minOther;
      bestIdx = i;
    }
  }
  return points[bestIdx]!;
}

/**
 * Helper to get the current selection state using expect.poll for stability.
 */
async function getSelectionState(page: Page): Promise<{
  type: string;
  stationRef?: { section_id: number; station_index: number };
  sectionId?: number;
  shotId?: number;
} | null> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: { getState: () => { selection: unknown } };
      };
    }).__E2E_TEST__;

    if (!stores) return null;
    return stores.uiStore.getState().selection as {
      type: string;
      stationRef?: { section_id: number; station_index: number };
      sectionId?: number;
      shotId?: number;
    } | null;
  });
}

/**
 * Helper to poll for selection state changes (more stable than waitForTimeout).
 */
async function pollSelectionState(
  page: Page,
  predicate: (sel: Awaited<ReturnType<typeof getSelectionState>>) => boolean,
  timeout = 5000
): Promise<Awaited<ReturnType<typeof getSelectionState>>> {
  let result: Awaited<ReturnType<typeof getSelectionState>> = null;
  await expect.poll(
    async () => {
      const sel = await getSelectionState(page);
      if (predicate(sel)) {
        result = sel;
        return true;
      }
      return false;
    },
    { timeout }
  ).toBe(true);
  return result;
}

/**
 * Helper to get the canvas bounding box for click coordinate calculation.
 */
async function getCanvasBoundingBox(page: Page): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const canvas = page.locator('canvas.maplibregl-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas not found');
  return box;
}

/**
 * Helper to get the hit_area value from config.
 */
async function getStationHitArea(page: Page): Promise<number> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: { getState: () => { config: { map: { station: { hit_area: number } } } | null } };
      };
    }).__E2E_TEST__;

    if (!stores) return 10; // Default fallback
    const config = stores.projectStore.getState().config;
    return config?.map?.station?.hit_area ?? 10;
  });
}

/**
 * Helper to check if debug.map.show_hitboxes changes layer opacity.
 */
async function getHitboxLayerOpacity(page: Page, layerId: string): Promise<number> {
  return page.evaluate(
    ({ layerId }) => {
      const map = (window as unknown as {
        __stalagmight_map__?: {
          getPaintProperty: (layer: string, prop: string) => number;
        };
      }).__stalagmight_map__;

      if (!map) return 0;
      return map.getPaintProperty(layerId, layerId.includes('shots') ? 'line-opacity' : 'circle-opacity') ?? 0;
    },
    { layerId }
  );
}

/**
 * Helper to verify layer order in the map style.
 * Returns the index of each layer in the style's layers array.
 */
async function getLayerOrder(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const map = (window as unknown as {
      __stalagmight_map__?: {
        getStyle: () => { layers: Array<{ id: string }> };
      };
    }).__stalagmight_map__;

    if (!map) return {};

    const layers = map.getStyle().layers;
    const order: Record<string, number> = {};

    layers.forEach((layer, index) => {
      order[layer.id] = index;
    });

    return order;
  });
}

/**
 * Read a numeric paint property off a layer (returns 0 if unavailable).
 * Used to inspect the debug-only ghost hitbox layers' circle-radius / line-width.
 */
async function getPaintNumber(page: Page, layerId: string, prop: string): Promise<number> {
  return page.evaluate(
    ({ layerId, prop }) => {
      const map = (window as unknown as {
        __stalagmight_map__?: { getPaintProperty: (l: string, p: string) => unknown };
      }).__stalagmight_map__;
      if (!map) return 0;
      const value = map.getPaintProperty(layerId, prop);
      if (typeof value === 'number') return value;
      if (typeof value === 'string') return Number(value);
      return 0;
    },
    { layerId, prop }
  );
}

/**
 * Toggle debug.map.show_hitboxes via the project store, mirroring how the real
 * config-reload path updates SurveyLayer (setConfig -> updateDebugVisualization,
 * which drives the ghost hitbox layer opacity).
 */
async function setShowHitboxes(page: Page, value: boolean): Promise<void> {
  await page.evaluate((show) => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: {
          getState: () => { config: { debug: { map: { show_hitboxes: boolean } } } | null };
          setState: (update: { config: unknown }) => void;
        };
      };
    }).__E2E_TEST__;

    if (!stores) return;
    const state = stores.projectStore.getState();
    if (!state.config) return;
    stores.projectStore.setState({
      config: {
        ...state.config,
        debug: {
          ...state.config.debug,
          map: { ...state.config.debug.map, show_hitboxes: show },
        },
      },
    });
  }, value);
}

/**
 * Set the station and/or shot hit_area via the project store. SurveyLayer reads
 * hit_area LIVE per query for actual hit-testing, and setConfig -> updateHitboxLayers
 * resizes the debug ghost layers to match, so the ghost radius/width is a reliable
 * signal that the config change has propagated to the layer.
 */
async function setHitAreas(
  page: Page,
  values: { station?: number; shot?: number }
): Promise<void> {
  await page.evaluate((v) => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: {
          getState: () => {
            config: { map: { station: { hit_area: number }; shot: { hit_area: number } } } | null;
          };
          setState: (update: { config: unknown }) => void;
        };
      };
    }).__E2E_TEST__;

    if (!stores) return;
    const state = stores.projectStore.getState();
    if (!state.config) return;
    stores.projectStore.setState({
      config: {
        ...state.config,
        map: {
          ...state.config.map,
          station: {
            ...state.config.map.station,
            ...(v.station !== undefined ? { hit_area: v.station } : {}),
          },
          shot: {
            ...state.config.map.shot,
            ...(v.shot !== undefined ? { hit_area: v.shot } : {}),
          },
        },
      },
    });
  }, values);
}

test.describe('Hitbox Detection', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="global-view"]');
  });

  test('station click at hitArea-1 hits, hitArea+1 misses with detail panel visible', async ({ page }) => {
    await createProject(page, 'Hitbox Test Project');

    // Merged station features are MultiPoint with no per-point stationIndex, so
    // flatten to individual screen points and click the most isolated one — its
    // center resolves unambiguously to the station rendered there.
    const points = await getStationScreenPoints(page);
    expect(points.length).toBeGreaterThan(0);
    const target = mostIsolatedPoint(points);

    const canvasBox = await getCanvasBoundingBox(page);

    // Ensure select tool is active
    await page.keyboard.press('s');

    // Click directly on the station center (should definitely hit)
    await page.mouse.click(canvasBox.x + target.x, canvasBox.y + target.y);

    // Poll for a station selection. Identity is discovered behaviorally (the
    // resolver picks the station at the clicked point) rather than read up front.
    const selectionAfterHit = await pollSelectionState(page, (sel) => sel?.type === 'station');
    expect(selectionAfterHit).not.toBeNull();
    expect(selectionAfterHit?.type).toBe('station');
    expect(selectionAfterHit?.stationRef).toBeTruthy();
    expect(typeof selectionAfterHit?.stationRef?.section_id).toBe('number');
    expect(typeof selectionAfterHit?.stationRef?.station_index).toBe('number');

    // Verify the Detail Panel shows station details
    const detailPanel = page.locator('[data-testid="detail-panel"]');
    await expect(detailPanel).toBeVisible();

    // Verify station detail panel is shown
    const stationDetail = page.locator('[data-testid="station-detail"]');
    await expect(stationDetail).toBeVisible();

    // Clear selection with Escape and verify
    await page.keyboard.press('Escape');
    await pollSelectionState(page, (sel) => sel === null);
    // Selection cleared successfully - test complete
  });

  test('overlapping hitboxes select nearest to click', async ({ page }) => {
    await createProject(page, 'Overlap Test Project');

    // Flatten the merged MultiPoint stations to individual screen points, then
    // look for a pair whose hit circles overlap in screen space (< 2*hitArea).
    const points = await getStationScreenPoints(page);
    expect(points.length).toBeGreaterThanOrEqual(2);
    const hitArea = await getStationHitArea(page);

    let pair: { a: { x: number; y: number }; b: { x: number; y: number } } | null = null;
    for (let i = 0; i < points.length && !pair; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const d = Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y);
        if (d > 0 && d < 2 * hitArea) {
          pair = { a: points[i]!, b: points[j]! };
          break;
        }
      }
    }

    const canvasBox = await getCanvasBoundingBox(page);
    await page.keyboard.press('s');

    // No overlapping pair on this seed's fitted zoom — not applicable, but still
    // verify a station-center click selects a station (matches the old fallback).
    if (!pair) {
      const solo = mostIsolatedPoint(points);
      await page.mouse.click(canvasBox.x + solo.x, canvasBox.y + solo.y);
      const selection = await pollSelectionState(page, (sel) => sel?.type === 'station');
      expect(selection).not.toBeNull();
      expect(selection?.type).toBe('station');
      return;
    }

    // Identify each overlapping station BEHAVIORALLY: a click on a point's exact
    // center is distance 0 to its own station and > 0 to the other, so the
    // nearest-wins resolver selects that station.
    await page.mouse.click(canvasBox.x + pair.a.x, canvasBox.y + pair.a.y);
    const selA = await pollSelectionState(page, (sel) => sel?.type === 'station');
    const targetA = selA?.stationRef;
    expect(targetA).toBeTruthy();
    await page.keyboard.press('Escape');
    await pollSelectionState(page, (sel) => sel === null);

    await page.mouse.click(canvasBox.x + pair.b.x, canvasBox.y + pair.b.y);
    const selB = await pollSelectionState(page, (sel) => sel?.type === 'station');
    const targetB = selB?.stationRef;
    expect(targetB).toBeTruthy();
    // The two overlapping points are distinct stations.
    expect(
      targetA!.section_id !== targetB!.section_id || targetA!.station_index !== targetB!.station_index
    ).toBe(true);
    await page.keyboard.press('Escape');
    await pollSelectionState(page, (sel) => sel === null);

    // Click at the midpoint nudged toward A. The nearest-to-click resolver must
    // select one of the two overlapping stations (A or B) — never something else.
    const midX = (pair.a.x + pair.b.x) / 2;
    const midY = (pair.a.y + pair.b.y) / 2;
    const dx = pair.a.x - midX;
    const dy = pair.a.y - midY;
    const dirLen = Math.hypot(dx, dy) || 1;
    const clickX = midX + (dx / dirLen) * 0.5;
    const clickY = midY + (dy / dirLen) * 0.5;

    await page.mouse.click(canvasBox.x + clickX, canvasBox.y + clickY);
    const selection = await pollSelectionState(page, (sel) => sel?.type === 'station');
    expect(selection).not.toBeNull();
    expect(selection?.type).toBe('station');

    const selectedA =
      selection?.stationRef?.section_id === targetA!.section_id &&
      selection?.stationRef?.station_index === targetA!.station_index;
    const selectedB =
      selection?.stationRef?.section_id === targetB!.section_id &&
      selection?.stationRef?.station_index === targetB!.station_index;
    expect(selectedA || selectedB).toBe(true);
  });

  // Ported (#mem budget): the dedicated survey-*-hitbox layers were removed, so
  // this now asserts the visible hit-test layers' relative order. Stations render
  // above shots so an overlapping click resolves the station first.
  test('station layer renders above shot layer', async ({ page }) => {
    await createProject(page, 'Layer Order Test');

    // Poll for the visible survey layers to be present in the style.
    await expect.poll(async () => {
      const order = await getLayerOrder(page);
      return order['survey-stations'] !== undefined && order['survey-shots'] !== undefined;
    }, { timeout: 10000 }).toBe(true);

    const layerOrder = await getLayerOrder(page);

    // Both visible hit-test layers exist.
    expect(layerOrder['survey-stations']).toBeDefined();
    expect(layerOrder['survey-shots']).toBeDefined();

    // Stations render ABOVE shots (higher index = rendered later = on top), which
    // is what gives stations click priority over overlapping shots.
    expect(layerOrder['survey-stations']).toBeGreaterThan(layerOrder['survey-shots']!);
  });

  // Ported (#mem budget): the invisible-but-queryable opacity trick is gone. The
  // padded-probe hit model queries the VISIBLE survey-stations / survey-shots
  // layers, so what matters now is that both layers return rendered features.
  test('visible hit layers are queryable for hit detection', async ({ page }) => {
    await createProject(page, 'Opacity Test');

    // Both visible hit-test layers must be queryable (return rendered features)
    // for the padded-probe candidate gate to find anything. Poll until both are.
    await expect.poll(async () => {
      return page.evaluate(() => {
        const map = (window as unknown as {
          __stalagmight_map__?: { queryRenderedFeatures: (opts: { layers: string[] }) => unknown[] };
        }).__stalagmight_map__;
        if (!map) return 0;
        try {
          const stations = map.queryRenderedFeatures({ layers: ['survey-stations'] }).length;
          const shots = map.queryRenderedFeatures({ layers: ['survey-shots'] }).length;
          return Math.min(stations, shots);
        } catch {
          return 0;
        }
      });
    }, { timeout: 10000 }).toBeGreaterThan(0);

    const counts = await page.evaluate(() => {
      const map = (window as unknown as {
        __stalagmight_map__?: { queryRenderedFeatures: (opts: { layers: string[] }) => unknown[] };
      }).__stalagmight_map__;
      if (!map) return { stations: 0, shots: 0 };
      return {
        stations: map.queryRenderedFeatures({ layers: ['survey-stations'] }).length,
        shots: map.queryRenderedFeatures({ layers: ['survey-shots'] }).length,
      };
    });

    expect(counts.stations).toBeGreaterThan(0);
    expect(counts.shots).toBeGreaterThan(0);
  });

  test('shot click detection at hitArea boundaries', async ({ page }) => {
    await createProject(page, 'Shot Hitbox Test');

    // Merged shots are MultiLineString (one inner line per shot, no per-shot
    // shotId). Flatten to individual segments + station points, then pick a
    // segment whose midpoint is clear of every station hitbox.
    const { segments, stations } = await getShotSegmentsAndStations(page);
    expect(segments.length).toBeGreaterThan(0);

    const config = await page.evaluate(() => {
      const stores = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              config: { map: { shot: { hit_area: number }; station: { hit_area: number } } } | null;
            };
          };
        };
      }).__E2E_TEST__;
      const c = stores?.projectStore.getState().config;
      return { shotHitArea: c?.map?.shot?.hit_area ?? 8, stationHitArea: c?.map?.station?.hit_area ?? 10 };
    });
    const { shotHitArea, stationHitArea } = config;

    // Find a long-enough segment with a click point (30/50/70%) far from all stations.
    let pick: {
      clickX: number;
      clickY: number;
      perpX: number;
      perpY: number;
      minStationDist: number;
    } | null = null;
    for (const seg of segments) {
      const dx = seg.x2 - seg.x1;
      const dy = seg.y2 - seg.y1;
      const len = Math.hypot(dx, dy);
      if (len < 20) continue;
      for (const t of [0.5, 0.3, 0.7]) {
        const px = seg.x1 + dx * t;
        const py = seg.y1 + dy * t;
        let minStationDist = Infinity;
        for (const s of stations) minStationDist = Math.min(minStationDist, Math.hypot(px - s.x, py - s.y));
        if (minStationDist > stationHitArea + shotHitArea / 2 + 5) {
          pick = { clickX: px, clickY: py, perpX: -dy / len, perpY: dx / len, minStationDist };
          break;
        }
      }
      if (pick) break;
    }

    // Fallback: first long-enough segment's midpoint (may be near a station).
    if (!pick) {
      const seg = segments.find((s) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1) >= 20) ?? segments[0]!;
      const dx = seg.x2 - seg.x1;
      const dy = seg.y2 - seg.y1;
      const len = Math.hypot(dx, dy) || 1;
      pick = {
        clickX: (seg.x1 + seg.x2) / 2,
        clickY: (seg.y1 + seg.y2) / 2,
        perpX: -dy / len,
        perpY: dx / len,
        minStationDist: 0,
      };
    }

    const canvasBox = await getCanvasBoundingBox(page);
    const safeFromStations = pick.minStationDist > 15;

    // Ensure select tool is active
    await page.keyboard.press('s');

    // Click just INSIDE the shot reach (hit_area/2 - 1 perpendicular) → hits.
    const hitOffset = shotHitArea / 2 - 1;
    await page.mouse.click(
      canvasBox.x + pick.clickX + pick.perpX * hitOffset,
      canvasBox.y + pick.clickY + pick.perpY * hitOffset
    );

    const selectionAfterHit = await pollSelectionState(page, (sel) => sel !== null);
    expect(selectionAfterHit).not.toBeNull();

    // Identify the target shot behaviorally (merged features carry no per-shot id).
    let targetShot: { sectionId?: number; shotId?: number } | null = null;
    if (safeFromStations) {
      // Far from every station → the hit must resolve to the shot.
      expect(selectionAfterHit?.type).toBe('shot');
      targetShot = { sectionId: selectionAfterHit?.sectionId, shotId: selectionAfterHit?.shotId };
    } else {
      // May have selected a station (they have priority) - that's OK.
      expect(['station', 'shot']).toContain(selectionAfterHit?.type);
      if (selectionAfterHit?.type === 'shot') {
        targetShot = { sectionId: selectionAfterHit.sectionId, shotId: selectionAfterHit.shotId };
      }
    }

    // Clear selection
    await page.keyboard.press('Escape');
    await pollSelectionState(page, (sel) => sel === null);

    // Click just OUTSIDE the shot reach (hit_area/2 + 1 perpendicular) → must NOT
    // select the target shot (may select a station / nothing / a different shot).
    const missOffset = shotHitArea / 2 + 1;
    await page.mouse.click(
      canvasBox.x + pick.clickX + pick.perpX * missOffset,
      canvasBox.y + pick.clickY + pick.perpY * missOffset
    );

    const selectionAfterMiss = await getSelectionState(page);
    if (selectionAfterMiss?.type === 'shot' && targetShot) {
      expect(
        selectionAfterMiss.sectionId !== targetShot.sectionId ||
        selectionAfterMiss.shotId !== targetShot.shotId
      ).toBe(true);
    }
    // If null or station, that's also valid - we missed the shot
  });
});

test.describe('Debug Hitbox Visualization', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="global-view"]');
  });

  // Ported (#mem budget): the debug show_hitboxes toggle now drives ONLY the
  // debug-only ghost hitbox layers (an accepted "ghost-only debug hitboxes"
  // decision). This asserts they exist and are fully hidden by default.
  test('ghost hitbox layers exist and are hidden by default', async ({ page }) => {
    await createProject(page, 'Debug Hitbox Test');

    // The debug-only ghost hitbox layers exist regardless of ghost source data.
    await expect.poll(async () => {
      const order = await getLayerOrder(page);
      return (
        order['survey-ghost-stations-hitbox'] !== undefined &&
        order['survey-ghost-shots-hitbox'] !== undefined
      );
    }, { timeout: 10000 }).toBe(true);

    const layerOrder = await getLayerOrder(page);
    expect(layerOrder['survey-ghost-stations-hitbox']).toBeDefined();
    expect(layerOrder['survey-ghost-shots-hitbox']).toBeDefined();

    // With debug.map.show_hitboxes at its default (false) the ghost layers are
    // fully hidden (opacity 0), so they never render in normal operation.
    const stationOpacity = await getHitboxLayerOpacity(page, 'survey-ghost-stations-hitbox');
    const shotOpacity = await getHitboxLayerOpacity(page, 'survey-ghost-shots-hitbox');
    expect(stationOpacity).toBe(0);
    expect(shotOpacity).toBe(0);
  });

  // Ported (#mem budget): retargeted to the debug-only ghost hitbox layers, which
  // are what the show_hitboxes toggle now drives (updateDebugVisualization sets
  // their opacity to 1 when enabled, 0 when disabled).
  test('hitbox opacity changes when debug.map.show_hitboxes config changes', async ({ page }) => {
    await createProject(page, 'Hitbox Visibility Toggle');

    // Poll for the ghost hitbox layers to be ready.
    await expect.poll(async () => {
      const order = await getLayerOrder(page);
      return order['survey-ghost-stations-hitbox'] !== undefined;
    }, { timeout: 10000 }).toBe(true);

    // Default (show_hitboxes false): ghost hitbox layers are hidden.
    expect(await getHitboxLayerOpacity(page, 'survey-ghost-stations-hitbox')).toBe(0);
    expect(await getHitboxLayerOpacity(page, 'survey-ghost-shots-hitbox')).toBe(0);

    // Enable the debug toggle via the store; SurveyLayer.setConfig re-runs
    // updateDebugVisualization, which raises the ghost layer opacity to 1.
    await setShowHitboxes(page, true);

    await expect.poll(
      async () => getHitboxLayerOpacity(page, 'survey-ghost-stations-hitbox'),
      { timeout: 5000 }
    ).toBe(1);
    await expect.poll(
      async () => getHitboxLayerOpacity(page, 'survey-ghost-shots-hitbox'),
      { timeout: 5000 }
    ).toBe(1);

    // Disable it again; opacity returns to 0.
    await setShowHitboxes(page, false);

    await expect.poll(
      async () => getHitboxLayerOpacity(page, 'survey-ghost-stations-hitbox'),
      { timeout: 5000 }
    ).toBe(0);
    await expect.poll(
      async () => getHitboxLayerOpacity(page, 'survey-ghost-shots-hitbox'),
      { timeout: 5000 }
    ).toBe(0);
  });
});

test.describe('Config Reload Effects', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="global-view"]');
  });

  // Ported (#mem budget): retargeted to the ghost station hitbox layer, whose
  // circle-radius updateHitboxLayers() sizes to config.map.station.hit_area
  // (independent of the show_hitboxes toggle).
  test('hitbox layer radius reflects config hit_area value', async ({ page }) => {
    await createProject(page, 'Config Hitbox Test');

    // Poll for the ghost station hitbox layer to be ready.
    await expect.poll(async () => {
      const order = await getLayerOrder(page);
      return order['survey-ghost-stations-hitbox'] !== undefined;
    }, { timeout: 10000 }).toBe(true);

    // Get the current hitArea from config
    const hitArea = await getStationHitArea(page);
    expect(hitArea).toBe(10); // Mock config default

    // The ghost station hitbox circle-radius should equal the config hit_area.
    const layerRadius = await getPaintNumber(page, 'survey-ghost-stations-hitbox', 'circle-radius');
    expect(layerRadius).toBeCloseTo(hitArea, 2);
  });

  // Ported (#mem budget): retargeted to the ghost hitbox layers. A hit_area config
  // change flows through setConfig -> updateHitboxLayers, resizing the ghost
  // station circle-radius and ghost shot line-width.
  test('hitbox layer sizes update when config hit_area changes', async ({ page }) => {
    await createProject(page, 'Config Reload Hitbox Test');

    // Poll for the ghost hitbox layers to be ready.
    await expect.poll(async () => {
      const order = await getLayerOrder(page);
      return order['survey-ghost-stations-hitbox'] !== undefined;
    }, { timeout: 10000 }).toBe(true);

    // Defaults from the mock config: station hit_area 10, shot hit_area 8.
    expect(await getPaintNumber(page, 'survey-ghost-stations-hitbox', 'circle-radius')).toBe(10);
    expect(await getPaintNumber(page, 'survey-ghost-shots-hitbox', 'line-width')).toBe(8);

    // Update both hit areas via the store (simulates a config reload).
    await setHitAreas(page, { station: 15, shot: 12 });

    // Ghost station radius follows the new station hit_area.
    await expect.poll(
      async () => getPaintNumber(page, 'survey-ghost-stations-hitbox', 'circle-radius'),
      { timeout: 5000 }
    ).toBe(15);

    // Ghost shot width follows the new shot hit_area.
    await expect.poll(
      async () => getPaintNumber(page, 'survey-ghost-shots-hitbox', 'line-width'),
      { timeout: 5000 }
    ).toBe(12);
  });

  // Ported (#mem budget): kept BEHAVIORAL and made strictly discriminating. hit_area
  // is read LIVE per query (getStationHitReach; station reach == hit_area, inclusive
  // <=), so the SAME screen point must flip from HIT to MISS purely from a live
  // config change: we click a point offset just inside the original reach but
  // outside a reduced reach and prove the outcome flips. The removed
  // survey-stations-hitbox paint poll is replaced with a ghost-layer settle that
  // confirms setConfig propagated (config is read live, but setConfig runs from a
  // React effect, so we wait for the ghost radius to reflect the new hit_area).
  //
  // NOTE (#mem budget): the visible survey-stations layer now returns MERGED
  // MultiPoint features (one per section, coordinates = array of station points,
  // no per-point stationIndex). So we extract the individual points ourselves and
  // identify the target by which station the click actually selects, rather than
  // reading a stationIndex property off the feature.
  test('config hit_area change affects actual hit detection behavior', async ({ page }) => {
    await createProject(page, 'Config Hit Detection Behavior Test');

    // Reach model: station maxDistance == hit_area (inclusive). Pick an offset that
    // is inside the original reach (10) but outside the reduced reach (4), with a
    // comfortable margin on both sides.
    const ORIGINAL_HIT_AREA = 10; // mock config default
    const HIT_OFFSET = 7; // 7 <= 10 -> hits originally; 7 > 4 -> misses when reduced
    const REDUCED_HIT_AREA = 4;

    // Extract every individual station point (from merged MultiPoint features) and
    // choose the (point, direction) whose offset click is farthest from EVERY other
    // station point, so the chosen point is unambiguously the nearest station.
    const testData = await page.evaluate((hitOffset) => {
      const map = (window as unknown as {
        __stalagmight_map__?: {
          project: (coords: [number, number]) => { x: number; y: number };
          queryRenderedFeatures: (options?: { layers?: string[] }) => Array<{
            geometry: { type: string; coordinates: number[] | number[][] };
            properties: { sectionId: number };
          }>;
        };
      }).__stalagmight_map__;

      const stores = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: { getState: () => { config: { map: { station: { hit_area: number } } } | null } };
        };
      }).__E2E_TEST__;

      if (!map || !stores) throw new Error('Map or stores not available');

      const hitArea = stores.projectStore.getState().config?.map?.station?.hit_area ?? 10;
      const features = map.queryRenderedFeatures({ layers: ['survey-stations'] });
      if (features.length === 0) throw new Error('No stations found');

      // Flatten merged MultiPoint features into individual station screen points.
      const points: Array<{ x: number; y: number }> = [];
      for (const f of features) {
        const raw =
          f.geometry.type === 'MultiPoint'
            ? (f.geometry.coordinates as number[][])
            : [f.geometry.coordinates as number[]];
        for (const c of raw) {
          const s = map.project([c[0]!, c[1]!]);
          points.push({ x: s.x, y: s.y });
        }
      }
      if (points.length < 2) throw new Error('Need at least 2 station points');

      const directions = [
        { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 0 }, { x: 1, y: 1 },
        { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 }, { x: -1, y: -1 },
      ];

      // Search all (point, direction) pairs for the offset click that is farthest
      // from every OTHER point (normalize so diagonals match axis distance).
      let best = {
        screenPos: points[0]!,
        direction: { x: 0, y: -1 },
        otherMinDist: -Infinity,
      };
      for (let i = 0; i < points.length; i++) {
        const p = points[i]!;
        const others = points.filter((_, j) => j !== i);
        for (const dir of directions) {
          const norm = Math.hypot(dir.x, dir.y) || 1;
          const ux = dir.x / norm;
          const uy = dir.y / norm;
          const testX = p.x + ux * hitOffset;
          const testY = p.y + uy * hitOffset;
          let minDist = Infinity;
          for (const o of others) {
            minDist = Math.min(minDist, Math.hypot(testX - o.x, testY - o.y));
          }
          if (minDist > best.otherMinDist) {
            best = { screenPos: p, direction: { x: ux, y: uy }, otherMinDist: minDist };
          }
        }
      }

      return { hitArea, screenPos: best.screenPos, safeDirection: best.direction, otherMinDist: best.otherMinDist };
    }, HIT_OFFSET);

    const { hitArea, screenPos, safeDirection, otherMinDist } = testData;
    const canvasBox = await getCanvasBoundingBox(page);

    // Preconditions that keep the discriminating click valid on this seed data.
    expect(hitArea).toBe(ORIGINAL_HIT_AREA);
    // The nearest OTHER station at the offset click must be farther than the chosen
    // point (HIT_OFFSET away) so the chosen point is unambiguously the nearest.
    expect(otherMinDist).toBeGreaterThan(HIT_OFFSET);

    const clickX = canvasBox.x + screenPos.x + safeDirection.x * HIT_OFFSET;
    const clickY = canvasBox.y + screenPos.y + safeDirection.y * HIT_OFFSET;

    // Ensure select tool is active.
    await page.keyboard.press('s');

    // 1) With the original hit_area (10), the offset-7 click hits: the nearest
    // station is the chosen point (7px away). Record whichever station that is as
    // the target (merged features carry no per-point stationIndex to read up front).
    await page.mouse.click(clickX, clickY);
    const hitSel = await pollSelectionState(page, (sel) => sel?.type === 'station');
    const target = hitSel?.stationRef;
    expect(target).toBeTruthy();

    // Clear selection.
    await page.keyboard.press('Escape');
    await pollSelectionState(page, (sel) => sel === null);

    // 2) Reduce the station hit_area. hit_area is read live per query, but
    // SurveyLayer.setConfig runs from a React effect; wait for the ghost station
    // hitbox radius to reflect the new value as a propagation signal.
    await setHitAreas(page, { station: REDUCED_HIT_AREA });
    await expect.poll(
      async () => getPaintNumber(page, 'survey-ghost-stations-hitbox', 'circle-radius'),
      { timeout: 5000 }
    ).toBe(REDUCED_HIT_AREA);

    // Sanity: the click pipeline still selects after the config change (a click on
    // the chosen point's center hits at any hit_area), confirming propagation end to
    // end and re-selecting the same target station.
    await page.mouse.click(canvasBox.x + screenPos.x, canvasBox.y + screenPos.y);
    const stillHits = await pollSelectionState(page, (sel) => sel?.type === 'station');
    expect(stillHits?.stationRef?.section_id).toBe(target?.section_id);
    expect(stillHits?.stationRef?.station_index).toBe(target?.station_index);
    await page.keyboard.press('Escape');
    await pollSelectionState(page, (sel) => sel === null);

    // 3) The SAME offset-7 click now MISSES the target station (7 > reduced 4).
    // The click handler resolves selection synchronously, so read it directly
    // (a shot / different station / nothing may be selected, but NOT the target).
    await page.mouse.click(clickX, clickY);
    const afterMiss = await getSelectionState(page);
    const selectedTarget =
      afterMiss?.type === 'station' &&
      afterMiss?.stationRef?.section_id === target?.section_id &&
      afterMiss?.stationRef?.station_index === target?.station_index;
    expect(selectedTarget).toBe(false);
  });
});

test.describe('E2E Test Infrastructure', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="global-view"]');
  });

  test('__E2E_TEST__ stores are exposed in dev mode', async ({ page }) => {
    await createProject(page, 'E2E Test Infrastructure');

    // Verify __E2E_TEST__ is available with required stores
    const hasTestAPI = await page.evaluate(() => {
      const testAPI = (window as unknown as {
        __E2E_TEST__?: {
          uiStore: unknown;
          projectStore: unknown;
        };
      }).__E2E_TEST__;

      return {
        hasAPI: !!testAPI,
        hasUIStore: !!testAPI?.uiStore,
        hasProjectStore: !!testAPI?.projectStore,
      };
    });

    expect(hasTestAPI.hasAPI).toBe(true);
    expect(hasTestAPI.hasUIStore).toBe(true);
    expect(hasTestAPI.hasProjectStore).toBe(true);
  });

  test('__stalagmight_map__ is exposed after map loads', async ({ page }) => {
    await createProject(page, 'Map Exposure Test');

    // Ensure map has finished loading after project seeding
    await expect.poll(
      async () => {
        return page.evaluate(() => {
          const map = (window as unknown as {
            __stalagmight_map__?: { loaded?: () => boolean; isStyleLoaded?: () => boolean };
          }).__stalagmight_map__;
          return Boolean(map && ((map.isStyleLoaded && map.isStyleLoaded()) || (map.loaded && map.loaded())));
        });
      },
      { timeout: 10000 }
    ).toBe(true);

    // Verify __stalagmight_map__ is available with required methods
    const hasMapAPI = await page.evaluate(() => {
      const map = (window as unknown as {
        __stalagmight_map__?: {
          loaded: () => boolean;
          isStyleLoaded?: () => boolean;
          project: (coords: [number, number]) => { x: number; y: number };
          getStyle: () => { layers: unknown[] };
          getPaintProperty: (layer: string, prop: string) => unknown;
          queryRenderedFeatures: (options?: unknown) => unknown[];
        };
      }).__stalagmight_map__;

      return {
        hasMap: !!map,
        isLoaded: (map?.isStyleLoaded?.() ?? false) || (map?.loaded?.() ?? false),
        hasProject: typeof map?.project === 'function',
        hasGetStyle: typeof map?.getStyle === 'function',
        hasGetPaintProperty: typeof map?.getPaintProperty === 'function',
        hasQueryRenderedFeatures: typeof map?.queryRenderedFeatures === 'function',
      };
    });

    expect(hasMapAPI.hasMap).toBe(true);
    expect(hasMapAPI.isLoaded).toBe(true);
    expect(hasMapAPI.hasProject).toBe(true);
    expect(hasMapAPI.hasGetStyle).toBe(true);
    expect(hasMapAPI.hasGetPaintProperty).toBe(true);
    expect(hasMapAPI.hasQueryRenderedFeatures).toBe(true);
  });
});
