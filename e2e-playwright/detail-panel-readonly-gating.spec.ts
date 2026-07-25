/**
 * E2E: the DetailPanel action-footer buttons are gated when editing is blocked (#260).
 *
 * The footer verbs (station Edit, shot Mark-as-<kind> / Delete, section Edit section)
 * all sit behind `useEditingBlocked()`. This spec asserts that gating through the
 * stable `data-testid`s rather than by scraping label text, so a copy change can't
 * silently turn the read-only assertion into a no-op.
 *
 * Two independent read-only sources are covered, because they compose differently:
 * - a remote SpeleoDB project open WITHOUT the write lock (`speleoStore.link`), and
 * - the closure-adjusted geometry view (`uiStore.geometryMode`), which has NO server
 *   backstop at all - read-only there rests entirely on this UI gating.
 *
 * Parallel-safe: all state is per-page (mocked IPC + `window.__E2E_TEST__` stores).
 */

import { test, expect, Page } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapIdle,
  type SectionSeed,
} from './helpers/app';

const sectionSeeds: SectionSeed[] = [
  {
    name: 'Main Tunnel',
    direction: 'in',
    shots: [
      { azimuth_in: 45, azimuth_out: 225, length: 10, depth_in: -1, depth_out: -3 },
      { azimuth_in: 90, azimuth_out: 270, length: 12, depth_in: -3, depth_out: -6 },
    ],
  },
];

/** The four footer verbs this spec gates, by the testids added in DetailPanel. */
const STATION_EDIT = 'station-edit-button';
const SHOT_KIND_CYCLE = 'shot-kind-cycle-button';
const SHOT_DELETE = 'shot-delete-button';
const SECTION_EDIT = 'section-edit-button';

interface SeededIds {
  sectionId: number;
  shotId: number;
}

async function seedIds(page: Page): Promise<SeededIds> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: {
          getState: () => {
            project: { sections: Array<{ id: number; shots: Array<{ id: number }> }> } | null;
          };
        };
      };
    }).__E2E_TEST__;
    const section = stores?.projectStore.getState().project?.sections[0];
    return { sectionId: section?.id ?? -1, shotId: section?.shots[0]?.id ?? -1 };
  });
}

async function select(page: Page, selection: Record<string, unknown>): Promise<void> {
  await page.evaluate((sel) => {
    const stores = (window as unknown as {
      __E2E_TEST__?: { uiStore: { getState: () => { setSelection: (s: unknown) => void } } };
    }).__E2E_TEST__;
    stores?.uiStore.getState().setSelection(sel);
  }, selection);
}

/** Open a remote SpeleoDB link WITHOUT the write lock (the read-only edit state). */
async function setSpeleoReadOnly(page: Page, readOnly: boolean): Promise<void> {
  await page.evaluate((on) => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        speleoStore: {
          getState: () => {
            setLinkOnOpen: (a: { permission: string | null }) => void;
            clearLink: () => void;
          };
        };
      };
    }).__E2E_TEST__;
    const speleo = stores?.speleoStore.getState();
    if (on) speleo?.setLinkOnOpen({ permission: 'READ_AND_WRITE' });
    else speleo?.clearLink();
  }, readOnly);
}

async function setClosureAdjusted(page: Page, on: boolean): Promise<void> {
  await page.evaluate((adjusted) => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: {
          getState: () => { setGeometryMode: (m: string, source?: string) => void };
        };
      };
    }).__E2E_TEST__;
    stores?.uiStore.getState().setGeometryMode(adjusted ? 'closureAdjusted' : 'measured', 'e2e');
  }, on);
}

test.describe('DetailPanel footer verbs are gated when editing is blocked', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Read-only Gating');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapIdle(page);
  });

  test('station Edit is enabled while editable and disabled read-only', async ({ page }) => {
    const { sectionId } = await seedIds(page);
    await select(page, {
      type: 'station',
      stationRef: { section_id: sectionId, station_index: 0 },
    });

    const edit = page.getByTestId(STATION_EDIT);
    await expect(edit).toBeEnabled();

    await setSpeleoReadOnly(page, true);
    await expect(edit).toBeDisabled();

    await setSpeleoReadOnly(page, false);
    await expect(edit).toBeEnabled();
  });

  test('shot Mark-as-kind and Delete are disabled read-only', async ({ page }) => {
    const { sectionId, shotId } = await seedIds(page);
    await select(page, { type: 'shot', sectionId, shotId });

    const markKind = page.getByTestId(SHOT_KIND_CYCLE);
    const del = page.getByTestId(SHOT_DELETE);
    await expect(markKind).toBeEnabled();
    await expect(del).toBeEnabled();

    await setSpeleoReadOnly(page, true);
    await expect(markKind).toBeDisabled();
    await expect(del).toBeDisabled();

    await setSpeleoReadOnly(page, false);
    await expect(markKind).toBeEnabled();
    await expect(del).toBeEnabled();
  });

  test('section Edit-section is disabled read-only', async ({ page }) => {
    const { sectionId } = await seedIds(page);
    await select(page, { type: 'section', sectionId });

    const editSection = page.getByTestId(SECTION_EDIT);
    await expect(editSection).toBeEnabled();

    await setSpeleoReadOnly(page, true);
    await expect(editSection).toBeDisabled();
  });

  test('the closure-adjusted view disables every footer verb too', async ({ page }) => {
    const { sectionId, shotId } = await seedIds(page);
    await setClosureAdjusted(page, true);

    await select(page, {
      type: 'station',
      stationRef: { section_id: sectionId, station_index: 0 },
    });
    await expect(page.getByTestId(STATION_EDIT)).toBeDisabled();

    await select(page, { type: 'shot', sectionId, shotId });
    await expect(page.getByTestId(SHOT_KIND_CYCLE)).toBeDisabled();
    await expect(page.getByTestId(SHOT_DELETE)).toBeDisabled();

    await select(page, { type: 'section', sectionId });
    await expect(page.getByTestId(SECTION_EDIT)).toBeDisabled();
  });
});
