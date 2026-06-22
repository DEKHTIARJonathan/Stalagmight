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
 *     — not the click point — sits under the cursor at the grab zoom (the `before`
 *     assertions; on un-fixed code these fail first).
 *   - #79 (zoom drift): the translate was a fixed offset from the grab's screen
 *     point, so on a mid-drag zoom the re-projected feature drifted. The fix
 *     re-projects the grab's world point each frame and re-applies on every map
 *     `move`. The `after` assertions zoom+pan mid-drag and re-check tracking.
 *
 * Two grab paths are covered because they take different code: a station grab
 * (`stationRef` → station coords) and a shot grab (`queryNearestShotPoint` →
 * nearest point on the shot line). There was no prior E2E for move-tool dragging.
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

test('move-segment grabbed on a STATION snaps + tracks across a mid-drag zoom (#79, #20)', async ({ page }) => {
  await setupMockedPage(page);
  await createProject(page, 'Station Grab Move Test');
  await waitForMapReady(page);
  await seedProjectWithSections(page, SECTION_SEEDS);
  await waitForMapIdle(page);

  await page.getByTestId('map-canvas').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('v');
  await waitForActiveTool(page, 'move_segment');

  const box = await page.getByTestId('map-canvas').boundingBox();
  if (!box) throw new Error('no canvas box');

  const { screen: s, lngLat } = await centerOnStation(page, 18);

  // Click-to-grab (the intentional click → move → click-to-drop UX) a few px OFF the
  // station center but inside its hit target — the baseline must snap to the EXACT
  // station, so the station (not the click point) tracks the cursor. Then move.
  await page.mouse.click(box.x + s.x + 6, box.y + s.y);
  const cursor = { x: s.x + 60, y: s.y - 40 };
  await page.mouse.move(box.x + cursor.x, box.y + cursor.y, { steps: 6 });

  // #20: at the original zoom the grabbed station (not the +6px click) sits under
  // the cursor — proves the snap-to-station baseline. (Un-fixed code fails HERE.)
  const before = await featureGap(page, lngLat, cursor);
  expect(before.hasPreview, 'drag preview exists after grab+move').toBe(true);
  expect(Math.abs(before.gx), 'x gap at grab zoom (station snap)').toBeLessThanOrEqual(3);
  expect(Math.abs(before.gy), 'y gap at grab zoom (station snap)').toBeLessThanOrEqual(3);

  // #79: zoom IN mid-drag (and pan, so the station is off the zoom anchor) WITHOUT
  // moving the mouse. Pre-fix the preview drifts; post-fix it re-projects.
  await page.evaluate(() => {
    const map = (window as unknown as { __stalagmight_map__?: import('maplibre-gl').Map }).__stalagmight_map__;
    if (!map) return;
    map.setZoom(map.getZoom() + 3);
    map.panBy([120, 90], { duration: 0 });
  });
  await waitForMapIdle(page);

  const after = await featureGap(page, lngLat, cursor);
  expect(after.hasPreview, 'drag preview survives the zoom').toBe(true);
  expect(Math.abs(after.gx), 'x gap after mid-drag zoom (station grab)').toBeLessThanOrEqual(3);
  expect(Math.abs(after.gy), 'y gap after mid-drag zoom (station grab)').toBeLessThanOrEqual(3);

  // Drop with a click at the current cursor — the UX is click-to-grab -> move ->
  // click-to-drop, so there's no mouse.down() to pair an up() with; a click is the
  // real drop and exercises the commit path.
  await page.mouse.click(box.x + cursor.x, box.y + cursor.y);
  await waitForMapIdle(page);
});

test('move-segment grabbed on a SHOT line snaps + tracks across a mid-drag zoom (#79, #20)', async ({ page }) => {
  await setupMockedPage(page);
  await createProject(page, 'Shot Grab Move Test');
  await waitForMapReady(page);
  await seedProjectWithSections(page, SECTION_SEEDS);
  await waitForMapIdle(page);

  await page.getByTestId('map-canvas').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('v');
  await waitForActiveTool(page, 'move_segment');

  const box = await page.getByTestId('map-canvas').boundingBox();
  if (!box) throw new Error('no canvas box');

  // Grab the segment by clicking a SHOT line (no station under the cursor) — this
  // takes the queryNearestShotPoint snap branch, distinct from the station path.
  const { screen: s, perp, lngLat } = await centerOnShotMidpoint(page, 18);

  // Click 3px PERPENDICULAR off the midpoint — inside the 8px-wide shot hitbox, but
  // off the centerline. The snap must pull to the nearest point ON the shot (≈ the
  // midpoint), so the midpoint — not the off-line click — tracks the cursor.
  await page.mouse.click(box.x + s.x + perp.x * 3, box.y + s.y + perp.y * 3);
  const cursor = { x: s.x + 60, y: s.y - 40 };
  await page.mouse.move(box.x + cursor.x, box.y + cursor.y, { steps: 6 });

  // Assert on gap MAGNITUDE (not per-axis): without the snap the grabbed point would
  // sit ~3px off (the perpendicular click offset); the snap collapses it to ~0. 1.5px
  // cleanly separates the two. (Un-fixed code fails HERE — proves the shot snap.)
  const before = await featureGap(page, lngLat, cursor);
  expect(before.hasPreview, 'drag preview exists after shot grab+move').toBe(true);
  expect(Math.hypot(before.gx, before.gy), 'gap at grab zoom (shot snap)').toBeLessThanOrEqual(1.5);

  await page.evaluate(() => {
    const map = (window as unknown as { __stalagmight_map__?: import('maplibre-gl').Map }).__stalagmight_map__;
    if (!map) return;
    map.setZoom(map.getZoom() + 3);
    map.panBy([120, 90], { duration: 0 });
  });
  await waitForMapIdle(page);

  const after = await featureGap(page, lngLat, cursor);
  expect(after.hasPreview, 'drag preview survives the zoom').toBe(true);
  expect(Math.abs(after.gx), 'x gap after mid-drag zoom (shot grab)').toBeLessThanOrEqual(3);
  expect(Math.abs(after.gy), 'y gap after mid-drag zoom (shot grab)').toBeLessThanOrEqual(3);

  // Drop with a click at the current cursor — the UX is click-to-grab -> move ->
  // click-to-drop, so there's no mouse.down() to pair an up() with; a click is the
  // real drop and exercises the commit path.
  await page.mouse.click(box.x + cursor.x, box.y + cursor.y);
  await waitForMapIdle(page);
});
