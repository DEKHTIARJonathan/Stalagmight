import { test, expect, Page } from './fixtures/coverage';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapIdle,
  type SectionSeed,
} from './helpers/app';

/**
 * E2E for the "Issue severity" Display coloring mode (#22). The mode bakes a
 * `color` property per shot/station feature (like depth), so we assert on the
 * `properties.color` of rendered features. Unlist warnings come from the backend
 * validator; the e2e mock returns none, so we inject them via the project store
 * (the same path warning-click.spec.ts uses) to drive red/yellow.
 *
 * Severity palette (fixed, themeColors): error #ef4444, warning #eab308,
 * clear #22c55e.
 */

const SEV_ERROR = '#ef4444';
const SEV_WARNING = '#eab308';
const SEV_CLEAR = '#22c55e';

/** One section, 3 shots → 4 stations (idx 0..3). shot i joins station i and i+1. */
const sectionSeeds: SectionSeed[] = [
  {
    name: 'Severity A',
    direction: 'in',
    shots: [
      { azimuth_in: 45, azimuth_out: 225, length: 12, depth_in: 0, depth_out: -6 },
      { azimuth_in: 90, azimuth_out: 270, length: 8, depth_in: -6, depth_out: -12 },
      { azimuth_in: 135, azimuth_out: 315, length: 6, depth_in: -12, depth_out: -15 },
    ],
  },
];

async function openDisplayMenu(page: Page): Promise<void> {
  await page.locator('button:has-text("Display")').click();
  await expect(page.locator('[data-testid="display-toggle-showStations"]')).toBeVisible({ timeout: 2000 });
}

async function isToggleOn(page: Page, toggleKey: string): Promise<boolean> {
  return (await page.locator(`[data-testid="display-toggle-${toggleKey}"]`).getAttribute('aria-pressed')) === 'true';
}

async function toggleDisplayOption(page: Page, toggleKey: string): Promise<void> {
  const colorKeys = ['showDepthGradient', 'showDistanceGradient', 'showIssueSeverity'];
  const before = await isToggleOn(page, toggleKey);
  // Color modes are single-select: turn one OFF by selecting Section, not by re-clicking the pill.
  if (before && colorKeys.includes(toggleKey)) {
    await page.locator('[data-testid="display-color-section"]').click();
  } else {
    await page.locator(`[data-testid="display-toggle-${toggleKey}"]`).click();
  }
  await expect.poll(async () => isToggleOn(page, toggleKey), { timeout: 2000 }).not.toBe(before);
}

async function getSectionIds(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __E2E_TEST__?: { projectStore: { getState: () => { project: { sections: Array<{ id: number }> } | null } } };
    }).__E2E_TEST__;
    return stores?.projectStore.getState().project?.sections.map((s) => s.id) ?? [];
  });
}

async function getShotIds(page: Page, sectionId: number): Promise<number[]> {
  return page.evaluate((secId) => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: { getState: () => { project: { sections: Array<{ id: number; shots: Array<{ id: number }> }> } | null } };
      };
    }).__E2E_TEST__;
    const section = stores?.projectStore.getState().project?.sections.find((s) => s.id === secId);
    return section?.shots.map((shot) => shot.id) ?? [];
  }, sectionId);
}

interface MockWarning {
  sectionId: number;
  shotId: number;
  shotIndex: number;
  code: string;
  message: string;
  severity: 'warning' | 'error';
  isResolved: boolean;
}

async function injectWarnings(page: Page, warnings: MockWarning[]): Promise<void> {
  await page.evaluate((w) => {
    const stores = (window as unknown as {
      __E2E_TEST__?: { projectStore: { setState: (s: { warnings: unknown[] }) => void } };
    }).__E2E_TEST__;
    stores?.projectStore.setState({ warnings: w });
  }, warnings);
}

async function issueSeverityFlag(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __E2E_TEST__?: { uiStore: { getState: () => { showIssueSeverity: boolean } } };
    }).__E2E_TEST__;
    return stores?.uiStore.getState().showIssueSeverity ?? false;
  });
}

/** Colors of rendered shot features keyed by shotId. */
async function shotColorsById(page: Page): Promise<Record<number, string>> {
  return page.evaluate(() => {
    const map = (window as unknown as {
      __stalagmight_map__?: {
        queryRenderedFeatures: (o: { layers: string[] }) => Array<{ properties: { shotId?: number; color?: string } }>;
      };
    }).__stalagmight_map__;
    const out: Record<number, string> = {};
    if (!map) return out;
    try {
      for (const f of map.queryRenderedFeatures({ layers: ['survey-shots'] })) {
        const id = f.properties?.shotId;
        if (id != null && f.properties?.color) out[id] = f.properties.color;
      }
    } catch { /* style not ready */ }
    return out;
  });
}

/** Colors of rendered station features keyed by stationIndex. */
async function stationColorsByIndex(page: Page): Promise<Record<number, string>> {
  return page.evaluate(() => {
    const map = (window as unknown as {
      __stalagmight_map__?: {
        queryRenderedFeatures: (o: { layers: string[] }) => Array<{ properties: { stationIndex?: number; color?: string } }>;
      };
    }).__stalagmight_map__;
    const out: Record<number, string> = {};
    if (!map) return out;
    try {
      for (const f of map.queryRenderedFeatures({ layers: ['survey-stations'] })) {
        const idx = f.properties?.stationIndex;
        if (idx != null && f.properties?.color) out[idx] = f.properties.color;
      }
    } catch { /* style not ready */ }
    return out;
  });
}

async function waitForShots(page: Page): Promise<void> {
  await expect.poll(async () => Object.keys(await shotColorsById(page)).length, { timeout: 5000 }).toBeGreaterThan(0);
}

test.describe('Issue Severity coloring (#22)', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProject(page, 'Issue Severity Test');
    await seedProjectWithSections(page, sectionSeeds);
    await waitForMapIdle(page);
    await waitForShots(page);
  });

  test('toggle paints clear geometry green and reverts when turned off', async ({ page }) => {
    await openDisplayMenu(page);
    expect(await isToggleOn(page, 'showIssueSeverity')).toBe(false);

    // Baseline: section colors, not the clear-green severity color.
    const shotsBefore = await shotColorsById(page);
    expect(Object.values(shotsBefore).some((c) => c.toLowerCase() !== SEV_CLEAR)).toBe(true);

    await toggleDisplayOption(page, 'showIssueSeverity');
    expect(await issueSeverityFlag(page)).toBe(true);

    // No warnings ⇒ every shot and station is green (clear).
    await expect.poll(async () => {
      const shots = await shotColorsById(page);
      const vals = Object.values(shots);
      return vals.length > 0 && vals.every((c) => c.toLowerCase() === SEV_CLEAR);
    }, { timeout: 3000 }).toBe(true);
    await expect.poll(async () => {
      const stations = await stationColorsByIndex(page);
      const vals = Object.values(stations);
      return vals.length > 0 && vals.every((c) => c.toLowerCase() === SEV_CLEAR);
    }, { timeout: 3000 }).toBe(true);

    // Off ⇒ section colors return (no longer all green).
    await toggleDisplayOption(page, 'showIssueSeverity');
    await expect.poll(async () => {
      const shots = await shotColorsById(page);
      return Object.values(shots).some((c) => c.toLowerCase() !== SEV_CLEAR);
    }, { timeout: 3000 }).toBe(true);
  });

  test('error/warning issues color the right shots and propagate to endpoint stations', async ({ page }) => {
    const sectionId = (await getSectionIds(page))[0]!;
    const shotIds = await getShotIds(page, sectionId);
    expect(shotIds.length).toBe(3);

    await injectWarnings(page, [
      { sectionId, shotId: shotIds[0]!, shotIndex: 0, code: 'ZERO_LENGTH', message: 'err', severity: 'error', isResolved: false },
      { sectionId, shotId: shotIds[1]!, shotIndex: 1, code: 'SHORT_SHOT', message: 'warn', severity: 'warning', isResolved: false },
      // Resolved error on the last shot must NOT color it.
      { sectionId, shotId: shotIds[2]!, shotIndex: 2, code: 'ZERO_LENGTH', message: 'err', severity: 'error', isResolved: true },
    ]);

    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showIssueSeverity');
    expect(await issueSeverityFlag(page)).toBe(true);

    await expect.poll(async () => {
      const shots = await shotColorsById(page);
      return [
        shots[shotIds[0]!]?.toLowerCase(),
        shots[shotIds[1]!]?.toLowerCase(),
        shots[shotIds[2]!]?.toLowerCase(),
      ].join(',');
    }, { timeout: 4000 }).toBe([SEV_ERROR, SEV_WARNING, SEV_CLEAR].join(','));

    // Stations: idx0 (shot0 only) = error; idx1 (shot0 error + shot1 warning) =
    // error (max); idx2 (shot1 warning + resolved shot2) = warning; idx3 = clear.
    await expect.poll(async () => {
      const st = await stationColorsByIndex(page);
      return [
        st[0]?.toLowerCase(),
        st[1]?.toLowerCase(),
        st[2]?.toLowerCase(),
        st[3]?.toLowerCase(),
      ].join(',');
    }, { timeout: 4000 }).toBe([SEV_ERROR, SEV_ERROR, SEV_WARNING, SEV_CLEAR].join(','));
  });

  test('is mutually exclusive with the depth gradient', async ({ page }) => {
    await openDisplayMenu(page);
    await toggleDisplayOption(page, 'showIssueSeverity');
    expect(await issueSeverityFlag(page)).toBe(true);

    // Enabling depth turns issue severity off (both paint the shots layer).
    await toggleDisplayOption(page, 'showDepthGradient');
    expect(await isToggleOn(page, 'showIssueSeverity')).toBe(false);
    expect(await issueSeverityFlag(page)).toBe(false);
    await expect(page.locator('[data-testid="depth-legend"]')).toBeVisible();

    // And the reverse: enabling issue severity turns depth off.
    await toggleDisplayOption(page, 'showIssueSeverity');
    expect(await issueSeverityFlag(page)).toBe(true);
    expect(await isToggleOn(page, 'showDepthGradient')).toBe(false);
  });

  test('switching to the Warnings tab auto-enables severity coloring and leaving reverts it', async ({ page }) => {
    // The Warnings-tab auto-highlight is DERIVED from the tab (issue #57, finding
    // #6) — it is never written to the store, so assert the rendered colors, not a
    // store flag. The persisted toggle stays off throughout.
    expect(await issueSeverityFlag(page)).toBe(false);

    // Baseline (Details tab): section colors, not the clear-green severity color.
    await expect.poll(async () => {
      const shots = await shotColorsById(page);
      return Object.values(shots).some((c) => c.toLowerCase() !== SEV_CLEAR);
    }, { timeout: 3000 }).toBe(true);

    // Opening the Warnings tab recomputes the map into issue-severity coloring
    // (global setting defaults on). With no warnings every shot paints clear-green.
    await page.getByTestId('detail-tab-warnings').click();
    await expect.poll(async () => {
      const shots = await shotColorsById(page);
      const vals = Object.values(shots);
      return vals.length > 0 && vals.every((c) => c.toLowerCase() === SEV_CLEAR);
    }, { timeout: 3000 }).toBe(true);
    // The persisted toggle was never mutated by the auto-highlight.
    expect(await issueSeverityFlag(page)).toBe(false);

    // Leaving recomputes from the persisted toggles (was off ⇒ section colors return).
    await page.getByTestId('detail-tab-details').click();
    await expect.poll(async () => {
      const shots = await shotColorsById(page);
      return Object.values(shots).some((c) => c.toLowerCase() !== SEV_CLEAR);
    }, { timeout: 3000 }).toBe(true);
  });
});
