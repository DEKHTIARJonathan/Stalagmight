import { test, expect, Page } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapReady,
  waitForActiveTool,
  type SectionSeed,
} from './helpers/app';

/**
 * E2E for the move-comment palette tint (#52): while the move-comment tool
 * (exactly `move_comment`, not the plain `comment` tool) is active, the
 * shots/stations color paint swaps to tint whichever feature owns a comment
 * with its palette color, and restores on deselect.
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
        depth_in: -1,
        depth_out: -2,
        comment: 'watch the ceiling here',
      },
      { azimuth_in: 90, azimuth_out: 90, length: 10, depth_in: -2, depth_out: -3 },
      { azimuth_in: 90, azimuth_out: 90, length: 10, depth_in: -3, depth_out: -4 },
    ],
  },
];

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

async function shotsLineColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const map = (window as unknown as {
      __stalagmight_map__?: { getPaintProperty: (l: string, p: string) => unknown };
    }).__stalagmight_map__;
    return map ? JSON.stringify(map.getPaintProperty('survey-shots', 'line-color')) : '';
  });
}

async function stationsCircleColor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const map = (window as unknown as {
      __stalagmight_map__?: { getPaintProperty: (l: string, p: string) => unknown };
    }).__stalagmight_map__;
    return map ? JSON.stringify(map.getPaintProperty('survey-stations', 'circle-color')) : '';
  });
}

async function shotGradientsVisibility(page: Page): Promise<string> {
  return page.evaluate(() => {
    const map = (window as unknown as {
      __stalagmight_map__?: { getLayoutProperty: (l: string, p: string) => unknown };
    }).__stalagmight_map__;
    return map ? String(map.getLayoutProperty('survey-shot-gradients', 'visibility')) : '';
  });
}

test.describe('Move-comment tool - palette tint (#52)', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Comment Palette Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapReady(page);
  });

  test('tints shots/stations with commentColor while move_comment is active, restores on deselect', async ({
    page,
  }) => {
    // Before the tool is active, the base paint has no comment tint.
    const basePaint = await shotsLineColor(page);
    expect(basePaint).not.toContain('commentColor');
    expect(await stationsCircleColor(page)).not.toContain('commentColor');

    await setActiveTool(page, 'move_comment');
    await waitForActiveTool(page, 'move_comment');

    await expect.poll(() => shotsLineColor(page)).toContain('commentColor');
    await expect.poll(() => stationsCircleColor(page)).toContain('commentColor');

    // Deselecting the tool (back to select) restores the EXACT prior paint
    // expression, not just the absence of `commentColor`.
    await setActiveTool(page, 'select');
    await waitForActiveTool(page, 'select');

    await expect.poll(() => shotsLineColor(page)).toBe(basePaint);
    await expect.poll(() => shotsLineColor(page)).not.toContain('commentColor');
    await expect.poll(() => stationsCircleColor(page)).not.toContain('commentColor');
  });

  test('the plain comment tool (not move_comment) does not tint shots/stations', async ({ page }) => {
    await setActiveTool(page, 'comment');
    await waitForActiveTool(page, 'comment');

    expect(await shotsLineColor(page)).not.toContain('commentColor');
    expect(await stationsCircleColor(page)).not.toContain('commentColor');
  });

  test('distance mode owns shots/stations color: move_comment yields, no commentColor in the ramp', async ({
    page,
  }) => {
    await toggleDisplay(page, 'showDistanceGradient');

    await setActiveTool(page, 'move_comment');
    await waitForActiveTool(page, 'move_comment');

    // The distance ramp owns line-color/circle-color while move_comment is
    // active alongside it; the palette tint does not fight it for the paint
    // property.
    await expect.poll(() => shotsLineColor(page)).not.toContain('commentColor');
    await expect.poll(() => stationsCircleColor(page)).not.toContain('commentColor');
  });

  test('depth gradient sub-layer is hidden while move_comment is active, restored on deselect', async ({
    page,
  }) => {
    await toggleDisplay(page, 'showDepthGradient');
    await expect.poll(() => shotGradientsVisibility(page)).toBe('visible');

    await setActiveTool(page, 'move_comment');
    await waitForActiveTool(page, 'move_comment');
    await expect.poll(() => shotGradientsVisibility(page)).toBe('none');

    await setActiveTool(page, 'select');
    await waitForActiveTool(page, 'select');
    await expect.poll(() => shotGradientsVisibility(page)).toBe('visible');
  });

  test('switching appMode to plan force-resets the tool and clears the tint', async ({ page }) => {
    await setActiveTool(page, 'move_comment');
    await waitForActiveTool(page, 'move_comment');
    await expect.poll(() => shotsLineColor(page)).toContain('commentColor');

    await setAppMode(page, 'plan');
    await waitForActiveTool(page, 'select');

    await expect.poll(() => shotsLineColor(page)).not.toContain('commentColor');
    expect(await activeTool(page)).toBe('select');
  });
});
