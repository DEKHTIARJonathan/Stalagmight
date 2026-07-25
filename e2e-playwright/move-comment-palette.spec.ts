import { test, expect, Page } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapReady,
  waitForActiveTool,
  waitForDrawnShots,
  getShotScreenPositions,
  getStationScreenPositions,
  readCanvasPixel,
  type PixelRgba,
  type SectionSeed,
  type ShotScreenPos,
} from './helpers/app';
import { commentColorForKey } from '../src/components/Map/surveyLayer/displayColor';
import { DISTANCE_NEAR, DISTANCE_FAR } from '../src/utils/distanceGradient';

/**
 * E2E for the move-comment palette tint (#52): while the move-comment tool
 * (exactly `move_comment`, not the plain `comment` tool) is active, whichever
 * shot / station OWNS a comment is drawn in its palette color, and the base
 * colors return on deselect.
 *
 * The survey is drawn by a custom WebGL layer now, so the old oracle is gone:
 * there is no `survey-shots` / `survey-stations` layer to read a `line-color` /
 * `circle-color` paint off, and no per-feature `commentColor` property for a
 * `coalesce` expression to pick up. The tint is resolved per feature at build
 * time into a packed vertex color instead (`commentTint` in
 * surveyLayer/customRender/colorResolvers.ts, fed from `activeTool ===
 * 'move_comment'` in SurveyLayer.syncCustomRender), so the oracle here is the
 * PAINTED PIXEL. That is strictly stronger than the old test: it checked that an
 * expression mentioned `commentColor`, this checks that the commented feature
 * really paints `commentColorForKey`'s color and that its uncommented neighbours
 * do not.
 *
 * `commentColorForKey` is imported from the product module so the expected color
 * is the app's own (the palette slot is an FNV-1a hash of the owner key, not
 * something a test should re-derive). Owner keys are `${sectionId}:s${shotId}`
 * for a shot comment and `${sectionId}:st${stationIndex}` for a station comment.
 */

/**
 * One section, 3 shots -> 4 stations. The FIRST shot owns a comment; the other
 * two do not, which is what makes "only the comment owner is tinted" observable.
 *
 * The depths zig-zag across the whole depth range on purpose: the depth-gradient
 * test below reads the ramp ALONG each shot, so every shot needs its two ends far
 * apart on the ramp. The station comment is added in `beforeEach` (station
 * comments live on the station records the backend synthesizes, not on the
 * section seed).
 */
const sectionSeeds: SectionSeed[] = [
  {
    name: 'Comment Main',
    direction: 'in',
    shots: [
      {
        azimuth_in: 90,
        azimuth_out: 90,
        length: 10,
        depth_in: 0,
        depth_out: -20,
        comment: 'ceiling',
      },
      { azimuth_in: 90, azimuth_out: 90, length: 10, depth_in: -20, depth_out: -5 },
      { azimuth_in: 90, azimuth_out: 90, length: 10, depth_in: -5, depth_out: -20 },
    ],
  },
];

/**
 * The station that owns a comment. NOT station 0: the section-name label anchors
 * there, and station 3 is the survey's free end, so its disc is only crossed by
 * one shot line.
 */
const COMMENTED_STATION = 3;

/** A station with no comment, used as the "must not be tinted" control. */
const PLAIN_STATION = 1;

async function setActiveTool(page: Page, tool: string): Promise<void> {
  await page.evaluate((t) => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: { uiStore: { getState: () => { setActiveTool: (tool: string) => void } } };
    }).__E2E_TEST__;
    e2e?.uiStore.getState().setActiveTool(t);
  }, tool);
}

async function activeTool(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: { uiStore: { getState: () => { activeTool: string } } };
    }).__E2E_TEST__;
    return e2e?.uiStore.getState()?.activeTool;
  });
}

async function toggleDisplay(page: Page, key: string): Promise<void> {
  await page.evaluate((k) => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: { uiStore: { getState: () => { toggleDisplay: (key: string) => void } } };
    }).__E2E_TEST__;
    e2e?.uiStore.getState().toggleDisplay(k);
  }, key);
}

async function setAppMode(page: Page, mode: string): Promise<void> {
  await page.evaluate((m) => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: { uiStore: { getState: () => { setAppMode: (mode: string) => void } } };
    }).__E2E_TEST__;
    e2e?.uiStore.getState().setAppMode(m);
  }, mode);
}

/** The seeded section's backend id (the mock assigns it, so never hard-code 1). */
async function getSectionId(page: Page): Promise<number> {
  const ids = await page.evaluate(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: { getState: () => { project: { sections: Array<{ id: number }> } | null } };
      };
    }).__E2E_TEST__;
    return e2e?.projectStore.getState().project?.sections.map((s) => s.id) ?? [];
  });
  expect(ids.length).toBe(1);
  return ids[0]!;
}

/** The section's shot ids, in seed order (shot 0 is the one that owns a comment). */
async function getShotIds(page: Page, sectionId: number): Promise<number[]> {
  return page.evaluate((secId) => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: {
          getState: () => {
            project: { sections: Array<{ id: number; shots: Array<{ id: number }> }> } | null;
          };
        };
      };
    }).__E2E_TEST__;
    const section = e2e?.projectStore.getState().project?.sections.find((s) => s.id === secId);
    return section?.shots.map((shot) => shot.id) ?? [];
  }, sectionId);
}

/**
 * Attach a comment to a station and wait for it to land in the store. Station
 * comments are not part of a section seed: they live on the station records the
 * backend synthesizes, so they go through the same `set_station_comment` command
 * the UI uses.
 */
async function setStationComment(
  page: Page,
  sectionId: number,
  stationIndex: number,
  comment: string,
): Promise<void> {
  await page.evaluate(
    async ({ secId, idx, text }) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              updateStationComment: (
                ref: { section_id: number; station_index: number },
                comment: string | null,
              ) => Promise<unknown>;
            };
          };
        };
      }).__E2E_TEST__;
      await e2e?.projectStore
        .getState()
        .updateStationComment({ section_id: secId, station_index: idx }, text);
    },
    { secId: sectionId, idx: stationIndex, text: comment },
  );
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ secId, idx }) => {
            const e2e = (window as unknown as {
              __E2E_TEST__?: {
                projectStore: {
                  getState: () => {
                    stations: Array<{
                      station_ref: { section_id: number; station_index: number };
                      comment?: string | null;
                    }>;
                  };
                };
              };
            }).__E2E_TEST__;
            return (
              e2e?.projectStore
                .getState()
                .stations.find(
                  (s) =>
                    s.station_ref.section_id === secId && s.station_ref.station_index === idx,
                )?.comment ?? null
            );
          },
          { secId: sectionId, idx: stationIndex },
        ),
      { timeout: 5000 },
    )
    .toBe(comment);
}

interface MapZoomHandle {
  getZoom: () => number;
  setZoom: (z: number) => void;
}

/**
 * Zoom in before probing painted pixels. The seeded survey is only a few metres
 * across, so at the fit-to-bounds zoom the whole thing is ~9 screen px wide and
 * the station discs cover the shot lines entirely, so a probe there cannot tell a
 * shot's color from a station's. `setZoom` is a jump (no animation) and the
 * geometry helpers project with the live map, so positions read after this call
 * already match the new view.
 *
 * A fit-to-bounds queued by the seed can still land after the map reports loaded
 * and take the zoom back, so hold the target zoom until the drawn shots really
 * are spread out on screen (`minSpanPx`).
 */
async function zoomIn(page: Page, delta = 4, minSpanPx = 40): Promise<void> {
  const target = await page.evaluate((d) => {
    const map = (window as unknown as { __stalagmight_map__?: MapZoomHandle }).__stalagmight_map__;
    if (!map) return 0;
    const z = map.getZoom() + d;
    map.setZoom(z);
    return z;
  }, delta);
  await expect
    .poll(
      async () => {
        await page.evaluate((z) => {
          const map = (window as unknown as { __stalagmight_map__?: MapZoomHandle })
            .__stalagmight_map__;
          if (map && map.getZoom() < z - 0.01) map.setZoom(z);
        }, target);
        const shots = await getShotScreenPositions(page);
        return shots.reduce(
          (m, s) => Math.max(m, Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y)),
          0,
        );
      },
      { timeout: 10000 },
    )
    .toBeGreaterThan(minSpanPx);
}

/** `#rrggbb` -> the opaque RGBA bytes the renderer packs it to. */
function hexRgba(hex: string): PixelRgba {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
}

const NEAR_RGBA = hexRgba(DISTANCE_NEAR);
const FAR_RGBA = hexRgba(DISTANCE_FAR);

/**
 * Whether a painted sample is the given color. The tolerance keeps the check
 * honest without being brittle: the comment palette, the section blue and the
 * distance ramp ends are all far apart, so nothing else lands inside it.
 */
function isColor(px: PixelRgba, hex: string, tolerance = 8): boolean {
  const [r, g, b] = hexRgba(hex);
  return (
    Math.abs(px[0] - r) <= tolerance &&
    Math.abs(px[1] - g) <= tolerance &&
    Math.abs(px[2] - b) <= tolerance
  );
}

/** True when two painted samples differ by more than `tolerance` on any channel. */
function differs(a: PixelRgba, b: PixelRgba, tolerance = 8): boolean {
  return (
    Math.abs(a[0] - b[0]) > tolerance ||
    Math.abs(a[1] - b[1]) > tolerance ||
    Math.abs(a[2] - b[2]) > tolerance
  );
}

/**
 * Name a painted sample against the colors this spec cares about, so a mismatch
 * reads as "painted section blue, expected the comment tint" instead of two RGB
 * triples. Falls through to the raw channels for anything unexpected.
 */
function describePixel(px: PixelRgba, palette: Record<string, string>): string {
  for (const [name, hex] of Object.entries(palette)) {
    if (isColor(px, hex)) return name;
  }
  return `rgb(${px[0]},${px[1]},${px[2]})`;
}

async function findShot(page: Page, sectionId: number, shotId: number): Promise<ShotScreenPos> {
  const shot = (await getShotScreenPositions(page)).find(
    (s) => s.sectionId === sectionId && s.shotId === shotId,
  );
  if (!shot) throw new Error(`shot ${sectionId}:${shotId} is not drawn`);
  return shot;
}

/**
 * Painted color a fraction `t` along a drawn shot (0 = from endpoint, 1 = to).
 * Stay clear of 0 / 1: a station disc paints over the line ends.
 *
 * The comment LABEL is not in the way at any `t`: comment labels anchor 'top'
 * with a `[0, 1.5]` em offset (labelLayout.ts `LABEL_KIND_LAYOUT`), i.e. the text
 * block starts ~1.5 em BELOW the feature, well clear of the 2 px line and the
 * 4 px-radius disc. That matters here because the comment tool forces both
 * comment kinds visible (`_enableCommentToolOverride`) and their glyphs are
 * painted in the same palette color as the tint.
 */
async function shotPixelAt(
  page: Page,
  sectionId: number,
  shotId: number,
  t: number,
): Promise<PixelRgba> {
  const shot = await findShot(page, sectionId, shotId);
  return readCanvasPixel(
    page,
    shot.from.x + (shot.to.x - shot.from.x) * t,
    shot.from.y + (shot.to.y - shot.from.y) * t,
  );
}

/** Painted color at a drawn shot's midpoint (flat outside depth mode). */
async function shotPixel(page: Page, sectionId: number, shotId: number): Promise<PixelRgba> {
  return shotPixelAt(page, sectionId, shotId, 0.5);
}

/** Painted FILL at the center of a drawn station's disc. */
async function stationPixel(
  page: Page,
  sectionId: number,
  stationIndex: number,
): Promise<PixelRgba> {
  const station = (await getStationScreenPositions(page)).find(
    (s) => s.sectionId === sectionId && s.stationIndex === stationIndex,
  );
  if (!station) throw new Error(`station ${sectionId}:${stationIndex} is not drawn`);
  return readCanvasPixel(page, station.x, station.y);
}

test.describe('Move-comment tool - palette tint (#52)', () => {
  let sectionId = 0;
  let shotIds: number[] = [];
  /** The palette color the commented shot must paint while move_comment is on. */
  let shotTint = '';
  /** ...and the one the commented station must paint. */
  let stationTint = '';
  /** Names for `describePixel`, so failures read as color names. */
  let palette: Record<string, string> = {};

  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Comment Palette Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapReady(page);
    await waitForDrawnShots(page, 3);

    sectionId = await getSectionId(page);
    shotIds = await getShotIds(page, sectionId);
    expect(shotIds.length).toBe(3);
    await setStationComment(page, sectionId, COMMENTED_STATION, 'silt');

    shotTint = commentColorForKey(`${sectionId}:s${shotIds[0]!}`);
    stationTint = commentColorForKey(`${sectionId}:st${COMMENTED_STATION}`);
    // The palette slots are hash-derived, so guard the fixture itself: if the two
    // owners ever collided on one slot, "the shot is tinted" and "the station is
    // tinted" would stop being independent facts.
    expect(shotTint).not.toBe(stationTint);
    palette = {
      shotTint,
      stationTint,
      distanceNear: DISTANCE_NEAR,
      distanceFar: DISTANCE_FAR,
    };

    await zoomIn(page);
  });

  test('tints shots/stations with commentColor while move_comment is active, restores on deselect', async ({
    page,
  }) => {
    // Before the tool is active nothing paints a comment-palette color: the
    // commented shot is painted exactly like its uncommented neighbours, and so
    // is the commented station.
    const basePlainShot = await shotPixel(page, sectionId, shotIds[1]!);
    const baseCommentedShot = await shotPixel(page, sectionId, shotIds[0]!);
    const basePlainStation = await stationPixel(page, sectionId, PLAIN_STATION);
    const baseCommentedStation = await stationPixel(page, sectionId, COMMENTED_STATION);
    expect(describePixel(baseCommentedShot, palette)).not.toBe('shotTint');
    expect(describePixel(baseCommentedStation, palette)).not.toBe('stationTint');
    expect(baseCommentedShot).toEqual(basePlainShot);
    expect(baseCommentedStation).toEqual(basePlainStation);

    await setActiveTool(page, 'move_comment');
    await waitForActiveTool(page, 'move_comment');

    // The comment OWNERS repaint in their palette colors.
    await expect
      .poll(async () => describePixel(await shotPixel(page, sectionId, shotIds[0]!), palette), {
        timeout: 3000,
      })
      .toBe('shotTint');
    await expect
      .poll(
        async () =>
          describePixel(await stationPixel(page, sectionId, COMMENTED_STATION), palette),
        { timeout: 3000 },
      )
      .toBe('stationTint');

    // ...and only they do: the features that own no comment are untouched, which
    // is the per-feature half of the old `coalesce(['get','commentColor'], base)`.
    expect(await shotPixel(page, sectionId, shotIds[1]!)).toEqual(basePlainShot);
    expect(await shotPixel(page, sectionId, shotIds[2]!)).toEqual(basePlainShot);
    expect(await stationPixel(page, sectionId, PLAIN_STATION)).toEqual(basePlainStation);

    // Deselecting the tool (back to select) restores the EXACT prior pixels, not
    // just "some other color" (the old test compared the whole paint expression).
    await setActiveTool(page, 'select');
    await waitForActiveTool(page, 'select');

    await expect
      .poll(async () => shotPixel(page, sectionId, shotIds[0]!), { timeout: 3000 })
      .toEqual(baseCommentedShot);
    await expect
      .poll(async () => stationPixel(page, sectionId, COMMENTED_STATION), { timeout: 3000 })
      .toEqual(baseCommentedStation);
  });

  test('the plain comment tool (not move_comment) does not tint shots/stations', async ({
    page,
  }) => {
    const baseCommentedShot = await shotPixel(page, sectionId, shotIds[0]!);
    const baseCommentedStation = await stationPixel(page, sectionId, COMMENTED_STATION);

    await setActiveTool(page, 'comment');
    await waitForActiveTool(page, 'comment');

    // The plain comment tool reveals the comment LABELS but must not repaint the
    // geometry: `commentTint` is `activeTool === 'move_comment'` exactly. The
    // labels anchor below the feature, so these probes see only the geometry.
    expect(describePixel(await shotPixel(page, sectionId, shotIds[0]!), palette)).not.toBe(
      'shotTint',
    );
    expect(
      describePixel(await stationPixel(page, sectionId, COMMENTED_STATION), palette),
    ).not.toBe('stationTint');
    expect(await shotPixel(page, sectionId, shotIds[0]!)).toEqual(baseCommentedShot);
    expect(await stationPixel(page, sectionId, COMMENTED_STATION)).toEqual(baseCommentedStation);
  });

  test('distance mode owns shots/stations color: move_comment yields, no commentColor in the ramp', async ({
    page,
  }) => {
    await toggleDisplay(page, 'showDistanceGradient');
    await expect(page.locator('[data-testid="distance-legend"]')).toBeVisible({ timeout: 3000 });

    await setActiveTool(page, 'move_comment');
    await waitForActiveTool(page, 'move_comment');

    // The distance ramp owns the shot line color and the station fill while
    // move_comment is active alongside it (the overlay is checked BEFORE the
    // comment tint in colorResolvers), so the palette tint never reaches a pixel.
    // The mock's distance field is |x| and it lays station i at x = i * 10, so
    // with 3 shots the scale is 0..30: station 3 sits at the field max, i.e. the
    // exact FAR end of the ramp, and the commented shot (stations 0 and 1, value
    // 5) lands strictly inside it.
    await expect
      .poll(
        async () =>
          describePixel(await stationPixel(page, sectionId, COMMENTED_STATION), palette),
        { timeout: 3000 },
      )
      .toBe('distanceFar');
    await expect
      .poll(async () => describePixel(await stationPixel(page, sectionId, 0), palette), {
        timeout: 3000,
      })
      .toBe('distanceNear');

    const commentedShotPx = await shotPixel(page, sectionId, shotIds[0]!);
    expect(describePixel(commentedShotPx, palette)).not.toBe('shotTint');
    // ...and it is a genuine ramp color, not some third fallback: every channel
    // lies strictly between the two ramp ends.
    for (let c = 0; c < 3; c++) {
      const lo = Math.min(NEAR_RGBA[c]!, FAR_RGBA[c]!);
      const hi = Math.max(NEAR_RGBA[c]!, FAR_RGBA[c]!);
      expect(commentedShotPx[c]!, `channel ${c} of ${commentedShotPx.slice(0, 3).join(',')}`)
        .toBeGreaterThan(lo);
      expect(commentedShotPx[c]!, `channel ${c} of ${commentedShotPx.slice(0, 3).join(',')}`)
        .toBeLessThan(hi);
    }
  });

  test('depth gradient sub-layer is hidden while move_comment is active, restored on deselect', async ({
    page,
  }) => {
    // The `survey-shot-gradients` sub-layer whose `visibility` this test used to
    // read no longer exists. Its successor is `useDepthEndpoints`
    // (colorResolvers.ts): in depth mode the renderer packs the shot's two
    // ENDPOINT depth colors and lets the GPU interpolate along the segment, which
    // is exactly what the sub-layer existed to draw. `commentTint` switches
    // `useDepthEndpoints` off, so the observable equivalent of "the sub-layer is
    // hidden" is "the shot stops ramping along its length and paints one flat
    // color", and "restored" is "it ramps again". Read at 0.3 / 0.7 along each
    // shot, clear of the station discs at the ends.
    const ramping = async (): Promise<string> => {
      const flags: string[] = [];
      for (const shotId of shotIds) {
        const near = await shotPixelAt(page, sectionId, shotId, 0.3);
        const far = await shotPixelAt(page, sectionId, shotId, 0.7);
        flags.push(differs(near, far) ? 'ramp' : 'flat');
      }
      return flags.join(',');
    };

    await toggleDisplay(page, 'showDepthGradient');
    await expect(page.locator('[data-testid="depth-legend"]')).toBeVisible({ timeout: 3000 });
    // Every seeded shot has different depths at its two ends, so all three ramp.
    await expect.poll(ramping, { timeout: 4000 }).toBe('ramp,ramp,ramp');

    await setActiveTool(page, 'move_comment');
    await waitForActiveTool(page, 'move_comment');
    await expect.poll(ramping, { timeout: 4000 }).toBe('flat,flat,flat');
    // The commented shot went flat because it took the palette tint; the other
    // two went flat because the depth ramp collapsed to their average-depth
    // color. Pin the first half so "flat" cannot be satisfied by the shots
    // vanishing.
    expect(describePixel(await shotPixelAt(page, sectionId, shotIds[0]!, 0.3), palette)).toBe(
      'shotTint',
    );

    await setActiveTool(page, 'select');
    await waitForActiveTool(page, 'select');
    await expect.poll(ramping, { timeout: 4000 }).toBe('ramp,ramp,ramp');
  });

  test('switching appMode to plan force-resets the tool and clears the tint', async ({ page }) => {
    await setActiveTool(page, 'move_comment');
    await waitForActiveTool(page, 'move_comment');
    await expect
      .poll(async () => describePixel(await shotPixel(page, sectionId, shotIds[0]!), palette), {
        timeout: 3000,
      })
      .toBe('shotTint');

    await setAppMode(page, 'plan');
    await waitForActiveTool(page, 'select');

    // Plan mode remounts the map read-only (closure-adjusted; the mock's adjusted
    // geometry equals the measured one, so the legs stay where they were) and
    // repaints the survey in the plan view's own palette - measured, a cyan family
    // that shifts by a byte or two per leg. So the survey-mode pixels captured
    // above are NOT a valid reference here, and neither is exact equality between
    // two legs.
    //
    // Wait for the plan geometry to actually be painted before judging the tint: for
    // a frame after the remount the shot's pixel is bare background, which is not
    // the palette color either and would satisfy the "tint is gone" poll vacuously.
    const bg = await readCanvasPixel(page, 8, 8);
    await expect
      .poll(async () => differs(await shotPixel(page, sectionId, shotIds[0]!), bg), {
        timeout: 5000,
      })
      .toBe(true);

    const planCommented = await shotPixel(page, sectionId, shotIds[0]!);
    const planPlain = await shotPixel(page, sectionId, shotIds[1]!);
    expect(describePixel(planCommented, palette)).not.toBe('shotTint');
    // The comment owner gets no special treatment any more: it paints what an
    // uncommented leg paints (within the plan palette's per-leg spread), which is
    // what the old "no commentColor left in the paint expression" assertion meant.
    expect(
      differs(planCommented, planPlain),
      `commented ${planCommented.slice(0, 3).join(',')} vs plain ${planPlain.slice(0, 3).join(',')}`,
    ).toBe(false);
    expect(await activeTool(page)).toBe('select');
  });
});
