import { test, expect, Page } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapReady,
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

test.describe('Move-comment tool — palette tint (#52)', () => {
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
    expect(await shotsLineColor(page)).not.toContain('commentColor');
    expect(await stationsCircleColor(page)).not.toContain('commentColor');

    await setActiveTool(page, 'move_comment');
    await expect.poll(() => activeTool(page)).toBe('move_comment');

    await expect.poll(() => shotsLineColor(page)).toContain('commentColor');
    await expect.poll(() => stationsCircleColor(page)).toContain('commentColor');

    // Deselecting the tool (back to select) restores the prior paint.
    await setActiveTool(page, 'select');
    await expect.poll(() => activeTool(page)).toBe('select');

    await expect.poll(() => shotsLineColor(page)).not.toContain('commentColor');
    await expect.poll(() => stationsCircleColor(page)).not.toContain('commentColor');
  });

  test('the plain comment tool (not move_comment) does not tint shots/stations', async ({ page }) => {
    await setActiveTool(page, 'comment');
    await expect.poll(() => activeTool(page)).toBe('comment');

    expect(await shotsLineColor(page)).not.toContain('commentColor');
    expect(await stationsCircleColor(page)).not.toContain('commentColor');
  });
});
