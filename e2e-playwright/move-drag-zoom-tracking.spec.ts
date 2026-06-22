import { test, expect, Page } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapReady,
  waitForMapIdle,
  waitForActiveTool,
  type SectionSeed,
} from './helpers/app';

/**
 * #79 / #20 — a move-tool drag must keep the grabbed point under the cursor across
 * a mid-drag ZOOM, and must grab the EXACT feature (not the imprecise click point).
 *
 * The drag preview is a `*-translate` (screen-pixel) offset. Two independent bugs,
 * each guarded here:
 *   - #20 (grab precision): the grab baselined on `unproject(click)`, which at low
 *     zoom lands meters off the feature. Each test clicks a few px OFF the feature
 *     and asserts the *feature* (snapped: a station, or the nearest point on a shot)
 *     — not the click point — sits under the cursor at the grab zoom (the `at grab
 *     zoom` checks; on un-fixed code these fail first).
 *   - #79 (zoom drift): the translate was a fixed offset from the grab's screen
 *     point, so on a mid-drag zoom the re-projected feature drifted. The fix
 *     re-projects the grab's world point each frame and re-applies on every map
 *     `move`. The `after mid-drag zoom` checks zoom+pan mid-drag and re-verify.
 *
 * Three grab paths, because they take different code: move_segment grabbed on a
 * station (`stationRef` → station coords, `updateDragPreview`), move_segment grabbed
 * on a shot line (`queryNearestShotPoint`, `updateDragPreview`), and move_station
 * (`updateStationDragPreview` — translate + per-shot geometry rebuild). There was no
 * prior E2E for move-tool dragging.
 *
 * Gap reads use `toPass` (not one-shot `evaluate`): the segment preview layer is
 * created after an async `getConnectedSectionIds` IPC, so a one-shot read can race
 * its creation on a slow CI runner.
 */

const SECTION_SEEDS: SectionSeed[] = [
  {
    name: 'Mover',
    direction: 'in',
    shots: [
      { azimuth_in: 45, azimuth_out: 225, length: 10, depth_in: 0, depth_out: -2 },
      { azimuth_in: 90, azimuth_out: 270, length: 15, depth_in: -2, depth_out: -5 },
    ],
  },
];

/** Center on a station at `zoom`; return its canvas screen position + lng/lat. */
async function centerOnStation(page: Page, zoom: number) {
  const ll = await page.evaluate((z) => {
    const map = (window as unknown as { __stalagmight_map__?: import('maplibre-gl').Map }).__stalagmight_map__;
    if (!map) return null;
    const src = map.getSource('survey-data-stations') as unknown as { serialize?: () => { data?: GeoJSON.FeatureCollection } };
    const fc = typeof src?.serialize === 'function' ? src.serialize().data : null;
    const pt = (fc as GeoJSON.FeatureCollection | null)?.features?.find((f) => f.geometry.type === 'Point');
    if (!pt || pt.geometry.type !== 'Point') return { err: 'no station Point' };
    const c = pt.geometry.coordinates as [number, number];
    map.setCenter(c);
    map.setZoom(z);
    return { lng: c[0], lat: c[1] };
  }, zoom);
  if (!ll || 'err' in ll) throw new Error(`centerOnStation: ${ll ? ll.err : 'no map'}`);
  await waitForMapIdle(page);
  const screen = await page.evaluate((m) => {
    const map = (window as unknown as { __stalagmight_map__?: import('maplibre-gl').Map }).__stalagmight_map__;
    const p = map!.project([m.lng, m.lat]);
    return { x: p.x, y: p.y };
  }, ll);
  return { screen, lngLat: ll };
}

/**
 * Center on a shot's midpoint at `zoom`; return its screen position, lng/lat, and the
 * unit screen-vector PERPENDICULAR to the shot. Clicking `screen + perp*n` puts the
 * cursor n px off the line so the snap's nearest-point-on-shot lands back on the
 * midpoint — i.e. it proves the grab used `queryNearestShotPoint`, not the click.
 */
async function centerOnShotMidpoint(page: Page, zoom: number) {
  const data = await page.evaluate((z) => {
    const map = (window as unknown as { __stalagmight_map__?: import('maplibre-gl').Map }).__stalagmight_map__;
    if (!map) return null;
    const src = map.getSource('survey-data-shots') as unknown as { serialize?: () => { data?: GeoJSON.FeatureCollection } };
    const fc = typeof src?.serialize === 'function' ? src.serialize().data : null;
    const line = (fc as GeoJSON.FeatureCollection | null)?.features?.find((f) => f.geometry.type === 'LineString');
    if (!line || line.geometry.type !== 'LineString') return { err: 'no shot LineString' };
    const cs = line.geometry.coordinates as [number, number][];
    const a = cs[0];
    const b = cs[1];
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    map.setCenter(mid);
    map.setZoom(z);
    return { lng: mid[0], lat: mid[1], a, b };
  }, zoom);
  if (!data || 'err' in data) throw new Error(`centerOnShotMidpoint: ${data ? data.err : 'no map'}`);
  await waitForMapIdle(page);
  const proj = await page.evaluate((d) => {
    const map = (window as unknown as { __stalagmight_map__?: import('maplibre-gl').Map }).__stalagmight_map__;
    const mid = map!.project([d.lng, d.lat]);
    const pa = map!.project(d.a);
    const pb = map!.project(d.b);
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    return { mid: { x: mid.x, y: mid.y }, perp: { x: -dy / len, y: dx / len } };
  }, data);
  return { screen: proj.mid, perp: proj.perp, lngLat: { lng: data.lng, lat: data.lat } };
}

/** Where the grabbed feature renders now (project + applied translate) vs `cursor`. */
async function featureGap(page: Page, lngLat: { lng: number; lat: number }, cursor: { x: number; y: number }) {
  return page.evaluate(
    ({ ll, c }) => {
      const map = (window as unknown as { __stalagmight_map__?: import('maplibre-gl').Map }).__stalagmight_map__;
      if (!map) return { hasPreview: false, gx: 0, gy: 0 };
      const hasPreview = map.getLayer('survey-drag-stations') != null;
      const t = (hasPreview
        ? (map.getPaintProperty('survey-drag-stations', 'circle-translate') as [number, number] | undefined)
        : null) ?? [0, 0];
      const p = map.project([ll.lng, ll.lat]);
      return { hasPreview, gx: p.x + t[0] - c.x, gy: p.y + t[1] - c.y };
    },
    { ll: lngLat, c: cursor },
  );
}

/**
 * Poll until the grabbed feature (rendered at `lngLat` + the preview translate) sits
 * within `maxMag` px of `cursor`. `toPass` retries to ride out the async preview-layer
 * creation + the per-frame re-apply settling after a zoom.
 */
async function expectTracksCursor(
  page: Page,
  lngLat: { lng: number; lat: number },
  cursor: { x: number; y: number },
  label: string,
  maxMag = 3,
) {
  await expect(async () => {
    const g = await featureGap(page, lngLat, cursor);
    expect(g.hasPreview, `${label}: drag preview present`).toBe(true);
    expect(Math.hypot(g.gx, g.gy), `${label}: gap from cursor (px)`).toBeLessThanOrEqual(maxMag);
  }).toPass({ timeout: 5000, intervals: [50, 100, 200, 400, 800] });
}

/** Zoom in +3 and pan (so the feature is off the zoom anchor) WITHOUT moving the mouse. */
async function zoomInAndPan(page: Page) {
  await page.evaluate(() => {
    const map = (window as unknown as { __stalagmight_map__?: import('maplibre-gl').Map }).__stalagmight_map__;
    if (!map) return;
    map.setZoom(map.getZoom() + 3);
    map.panBy([120, 90], { duration: 0 });
  });
  await waitForMapIdle(page);
}

/** First + last station of the section, centered to fit both at `zoom`. */
async function firstAndLastStation(page: Page, zoom: number) {
  const data = await page.evaluate((z) => {
    const map = (window as unknown as { __stalagmight_map__?: import('maplibre-gl').Map }).__stalagmight_map__;
    if (!map) return null;
    const src = map.getSource('survey-data-stations') as unknown as { serialize?: () => { data?: GeoJSON.FeatureCollection } };
    const fc = typeof src?.serialize === 'function' ? src.serialize().data : null;
    const pts = ((fc as GeoJSON.FeatureCollection | null)?.features ?? [])
      .filter((f) => f.geometry.type === 'Point')
      .map((f) => (f.geometry as GeoJSON.Point).coordinates as [number, number]);
    if (pts.length < 2) return { err: 'need >=2 stations' };
    const a = pts[0];
    const b = pts[pts.length - 1];
    map.setCenter([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    map.setZoom(z);
    return { a, b };
  }, zoom);
  if (!data || 'err' in data) throw new Error(`firstAndLastStation: ${data ? data.err : 'no map'}`);
  await waitForMapIdle(page);
  const screens = await page.evaluate((d) => {
    const map = (window as unknown as { __stalagmight_map__?: import('maplibre-gl').Map }).__stalagmight_map__;
    const pa = map!.project(d.a);
    const pb = map!.project(d.b);
    return { a: { x: pa.x, y: pa.y }, b: { x: pb.x, y: pb.y } };
  }, data);
  return {
    a: { lngLat: { lng: data.a[0], lat: data.a[1] }, screen: screens.a },
    b: { lngLat: { lng: data.b[0], lat: data.b[1] }, screen: screens.b },
  };
}

/** Current screen position of a lng/lat (e.g. to recompute a target after a zoom). */
async function projectLngLat(page: Page, lngLat: { lng: number; lat: number }) {
  return page.evaluate((ll) => {
    const map = (window as unknown as { __stalagmight_map__?: import('maplibre-gl').Map }).__stalagmight_map__;
    const p = map!.project([ll.lng, ll.lat]);
    return { x: p.x, y: p.y };
  }, lngLat);
}

async function activateTool(page: Page, key: string, tool: string) {
  await page.getByTestId('map-canvas').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press(key);
  await waitForActiveTool(page, tool);
}

test('move_segment grabbed on a STATION snaps + tracks across a mid-drag zoom (#79, #20)', async ({ page }) => {
  await setupMockedPage(page);
  await createProject(page, 'Station Grab Move Test');
  await waitForMapReady(page);
  await seedProjectWithSections(page, SECTION_SEEDS);
  await waitForMapIdle(page);
  await activateTool(page, 'v', 'move_segment');

  const box = await page.getByTestId('map-canvas').boundingBox();
  if (!box) throw new Error('no canvas box');

  const { screen: s, lngLat } = await centerOnStation(page, 18);

  // Click-to-grab (the intentional click → move → click-to-drop UX) a few px OFF the
  // station center but inside its hit target — the baseline must snap to the EXACT
  // station, so the station (not the click point) tracks the cursor. Then move.
  await page.mouse.click(box.x + s.x + 6, box.y + s.y);
  const cursor = { x: s.x + 60, y: s.y - 40 };
  await page.mouse.move(box.x + cursor.x, box.y + cursor.y, { steps: 6 });

  await expectTracksCursor(page, lngLat, cursor, '#20 station snap at grab zoom');
  await zoomInAndPan(page);
  await expectTracksCursor(page, lngLat, cursor, '#79 station after mid-drag zoom');

  // Drop with a click at the current cursor (click-to-grab → move → click-to-drop;
  // there's no mouse.down() to pair an up() with — a click is the real drop).
  await page.mouse.click(box.x + cursor.x, box.y + cursor.y);
  await waitForMapIdle(page);
});

test('move_segment grabbed on a SHOT line snaps + tracks across a mid-drag zoom (#79, #20)', async ({ page }) => {
  await setupMockedPage(page);
  await createProject(page, 'Shot Grab Move Test');
  await waitForMapReady(page);
  await seedProjectWithSections(page, SECTION_SEEDS);
  await waitForMapIdle(page);
  await activateTool(page, 'v', 'move_segment');

  const box = await page.getByTestId('map-canvas').boundingBox();
  if (!box) throw new Error('no canvas box');

  // Grab the segment by clicking a SHOT line (no station under the cursor) — this
  // takes the queryNearestShotPoint snap branch, distinct from the station path.
  const { screen: s, perp, lngLat } = await centerOnShotMidpoint(page, 18);

  // Click 3px PERPENDICULAR off the midpoint — inside the 8px-wide shot hitbox, but
  // off the centerline. The snap must pull to the nearest point ON the shot (≈ the
  // midpoint), so the midpoint — not the off-line click — tracks the cursor. Asserting
  // gap MAGNITUDE ≤1.5 cleanly separates snap (~0) from no-snap (~3px = the offset).
  await page.mouse.click(box.x + s.x + perp.x * 3, box.y + s.y + perp.y * 3);
  const cursor = { x: s.x + 60, y: s.y - 40 };
  await page.mouse.move(box.x + cursor.x, box.y + cursor.y, { steps: 6 });

  await expectTracksCursor(page, lngLat, cursor, '#20 shot snap at grab zoom', 1.5);
  await zoomInAndPan(page);
  await expectTracksCursor(page, lngLat, cursor, '#79 shot after mid-drag zoom');

  await page.mouse.click(box.x + cursor.x, box.y + cursor.y);
  await waitForMapIdle(page);
});

test('move_station grabbed off-center snaps + tracks across a mid-drag zoom (#79, #20)', async ({ page }) => {
  // Distinct rendering path: move_station uses updateStationDragPreview (translate +
  // per-shot geometry rebuild), not the segment translate of the tests above.
  await setupMockedPage(page);
  await createProject(page, 'Station Move Test');
  await waitForMapReady(page);
  await seedProjectWithSections(page, SECTION_SEEDS);
  await waitForMapIdle(page);
  await activateTool(page, 't', 'move_station');

  const box = await page.getByTestId('map-canvas').boundingBox();
  if (!box) throw new Error('no canvas box');

  const { screen: s, lngLat } = await centerOnStation(page, 18);

  // Grab the station a few px off-center; the baseline must snap to the exact station.
  await page.mouse.click(box.x + s.x + 6, box.y + s.y);
  const cursor = { x: s.x + 60, y: s.y - 40 };
  await page.mouse.move(box.x + cursor.x, box.y + cursor.y, { steps: 6 });

  await expectTracksCursor(page, lngLat, cursor, '#20 move_station snap at grab zoom');
  await zoomInAndPan(page);
  await expectTracksCursor(page, lngLat, cursor, '#79 move_station after mid-drag zoom');

  await page.mouse.click(box.x + cursor.x, box.y + cursor.y);
  await waitForMapIdle(page);
});

test('move_station snap-to-target holds across a mid-drag zoom (snap + #79)', async ({ page }) => {
  // Guards the M2 split: the per-frame zoom re-apply skips the O(all-stations) snap SCAN
  // but must still re-ALIGN a held snap at the new zoom. Grab one station, drag onto
  // another (snap), then zoom — the dragged station must stay locked on the target, not
  // jump back to the raw cursor.
  await setupMockedPage(page);
  await createProject(page, 'Station Snap Test');
  await waitForMapReady(page);
  await seedProjectWithSections(page, SECTION_SEEDS);
  await waitForMapIdle(page);
  await activateTool(page, 't', 'move_station');

  const box = await page.getByTestId('map-canvas').boundingBox();
  if (!box) throw new Error('no canvas box');

  const { a: origin, b: target } = await firstAndLastStation(page, 17);

  // Grab the origin station, then move to 5px OFF the target (inside the 10px snap
  // threshold). Snap must pull the origin ONTO the target, so it renders at the target
  // (gap ~0), NOT at the 5px-off cursor — that's how we know snapping fired.
  await page.mouse.click(box.x + origin.screen.x + 4, box.y + origin.screen.y);
  const near = { x: target.screen.x + 5, y: target.screen.y };
  await page.mouse.move(box.x + near.x, box.y + near.y, { steps: 8 });
  await expectTracksCursor(page, origin.lngLat, target.screen, 'snap: origin aligned onto target', 2);

  // Zoom mid-drag: the scan is skipped, but the held snap must re-align at the new zoom.
  // A naive skip would drop the origin back onto the raw cursor (~5px off the target).
  await zoomInAndPan(page);
  const targetAfter = await projectLngLat(page, target.lngLat);
  await expectTracksCursor(page, origin.lngLat, targetAfter, 'snap: origin still on target after zoom', 2);

  await page.keyboard.press('Escape');
});
