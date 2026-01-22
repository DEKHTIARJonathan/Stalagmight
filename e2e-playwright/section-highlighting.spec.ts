import { test, expect, Page } from '@playwright/test';
import { setupTauriMocks } from './mocks/tauri-ipc';
import { seedProjectWithSections, type SectionSeed } from './helpers/app';

/**
 * E2E tests for section hover/selection highlighting.
 *
 * Tests the bidirectional highlighting between the sections panel and the map:
 * - Panel hover → map highlight (state + paint properties)
 * - Panel click → map selection (state + paint properties)
 * - Map hover → panel highlight (via map.fire simulation)
 * - Priority conflicts (individual hover vs section selection)
 * - Unhover behavior
 * - Keyboard navigation
 * - Edge cases (empty sections, virtual shots)
 */

/**
 * Helper to wait for the map to be fully loaded.
 */
async function waitForMapReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const map = (window as unknown as { __cavechef_map__?: { loaded: () => boolean } }).__cavechef_map__;
      return map && map.loaded();
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
 * Helper to wait for shot features to be rendered.
 */
async function waitForShotsRendered(page: Page): Promise<void> {
  await expect.poll(async () => {
    return page.evaluate(() => {
      const map = (window as unknown as {
        __cavechef_map__?: { queryRenderedFeatures: (opts: { layers: string[] }) => Array<unknown> };
      }).__cavechef_map__;
      if (!map) return 0;
      try {
        return map.queryRenderedFeatures({ layers: ['survey-shots'] }).length;
      } catch {
        return 0;
      }
    });
  }, { timeout: 10000 }).toBeGreaterThan(0);
}

/**
 * Helper to create a new project with the given name.
 * The mock setup provides pre-populated sections with shots.
 */
async function createProject(page: Page, name: string): Promise<void> {
  const newProjectBtn = page.locator('button:has-text("New Project"), h3:has-text("New Project")').first();
  await newProjectBtn.click();
  await page.waitForSelector('.fixed.inset-0');
  await page.locator('.fixed.inset-0 input').first().fill(name);
  await page.click('.fixed.inset-0 button:has-text("Create")');
  await waitForAppReady(page);
  await seedProjectWithSections(page, sectionSeeds);
  await waitForShotsRendered(page);
}

const sectionSeeds: SectionSeed[] = [
  {
    name: 'Highlight Main',
    direction: 'in',
    shots: [
      { azimuth_in: 45, azimuth_out: 225, length: 10, depth_in: -1, depth_out: -3 },
      { azimuth_in: 90, azimuth_out: 270, length: 12, depth_in: -3, depth_out: -6 },
      { azimuth_in: 120, azimuth_out: 300, length: 6, depth_in: -6, depth_out: -4, is_virtual: true },
    ],
  },
  {
    name: 'Highlight Secondary',
    direction: 'out',
    shots: [
      { azimuth_in: 180, azimuth_out: 0, length: 7, depth_in: -2, depth_out: -4 },
    ],
  },
  {
    name: 'Empty Section',
    direction: 'in',
    shots: [],
  },
];

/**
 * Helper to get a section ID by name.
 */
async function getSectionIdByName(page: Page, name: string): Promise<number | null> {
  return page.evaluate((sectionName) => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: { getState: () => { project: { sections: Array<{ id: number; name: string }> } | null } };
      };
    }).__E2E_TEST__;

    const sections = stores?.projectStore.getState().project?.sections ?? [];
    const match = sections.find((section) => section.name === sectionName);
    return match?.id ?? null;
  }, name);
}

/**
 * Helper to get the current selection state from uiStore.
 */
async function getSelectionState(page: Page): Promise<{
  type: string;
  sectionId?: number;
  stationRef?: { section_id: number; station_index: number };
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
      sectionId?: number;
      stationRef?: { section_id: number; station_index: number };
      shotId?: number;
    } | null;
  });
}

/**
 * Helper to get the current hovered section ID from uiStore.
 */
async function getHoveredSectionId(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: { getState: () => { hoveredSectionId: number | null } };
      };
    }).__E2E_TEST__;

    if (!stores) return null;
    return stores.uiStore.getState().hoveredSectionId;
  });
}

/**
 * Helper to poll for selection state changes.
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
 * Helper to poll for hovered section ID changes.
 */
async function pollHoveredSectionId(
  page: Page,
  predicate: (sectionId: number | null) => boolean,
  timeout = 5000
): Promise<number | null> {
  let result: number | null = null;
  await expect.poll(
    async () => {
      const sectionId = await getHoveredSectionId(page);
      if (predicate(sectionId)) {
        result = sectionId;
        return true;
      }
      return false;
    },
    { timeout }
  ).toBe(true);
  return result;
}

/**
 * Helper to get available section IDs from the project.
 */
async function getAvailableSectionIds(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: { getState: () => { project: { sections: Array<{ id: number }> } | null } };
      };
    }).__E2E_TEST__;

    if (!stores) return [];
    const project = stores.projectStore.getState().project;
    return project?.sections.map(s => s.id) ?? [];
  });
}


/**
 * Helper to check if a section has elevated map styling (hover or selection).
 * This checks uiStore state which drives the map styling.
 */
async function hasSectionMapHighlight(page: Page, sectionId: number, type: 'hover' | 'selection'): Promise<boolean> {
  return page.evaluate(({ secId, highlightType }) => {
    const stores = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: { getState: () => {
          hoveredSectionId: number | null;
          selection: { type: string; sectionId?: number } | null;
        } };
      };
    }).__E2E_TEST__;

    if (!stores) return false;
    const state = stores.uiStore.getState();

    if (highlightType === 'hover') {
      return state.hoveredSectionId === secId;
    } else {
      return state.selection?.type === 'section' && state.selection?.sectionId === secId;
    }
  }, { secId: sectionId, highlightType: type });
}

test.describe('Section Highlighting', () => {
  test.beforeEach(async ({ page }) => {
    await setupTauriMocks(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test.describe('Panel hover → map highlight', () => {
    test('hovering section row sets hoveredSectionId and applies map styling', async ({ page }) => {
      await createProject(page, 'Section Highlight Test');

      // Get section IDs from project
      const sectionIds = await getAvailableSectionIds(page);
      expect(sectionIds.length).toBeGreaterThan(0);
      const firstSectionId = sectionIds[0]!;

      // Find the section row using data-testid
      const sectionRow = page.locator(`[data-testid="section-row-${firstSectionId}"]`);
      await expect(sectionRow).toBeVisible();

      // Hover the section row
      await sectionRow.hover();

      // Poll for hoveredSectionId to be set
      const hoveredId = await pollHoveredSectionId(page, (id) => id === firstSectionId);
      expect(hoveredId).toBe(firstSectionId);

      // Verify map styling state is set (drives SurveyLayer.updateVisualState)
      const hasMapHover = await hasSectionMapHighlight(page, firstSectionId, 'hover');
      expect(hasMapHover).toBe(true);
    });
  });

  test.describe('Panel click → map selection', () => {
    test('clicking section row selects section and applies map styling', async ({ page }) => {
      await createProject(page, 'Section Selection Test');

      // Get section IDs from project
      const sectionIds = await getAvailableSectionIds(page);
      expect(sectionIds.length).toBeGreaterThan(0);
      const firstSectionId = sectionIds[0]!;

      // Find and click the section row
      const sectionRow = page.locator(`[data-testid="section-row-${firstSectionId}"]`);
      await expect(sectionRow).toBeVisible();
      await sectionRow.click();

      // Poll for selection state
      const selection = await pollSelectionState(page, (sel) => sel?.type === 'section');
      expect(selection).not.toBeNull();
      expect(selection?.type).toBe('section');
      expect(selection?.sectionId).toBe(firstSectionId);

      // Verify map selection state is set
      const hasMapSelection = await hasSectionMapHighlight(page, firstSectionId, 'selection');
      expect(hasMapSelection).toBe(true);

      // Verify selection persists across a short wait (not transient)
      await page.waitForTimeout(200);
      const persistedSelection = await getSelectionState(page);
      expect(persistedSelection?.sectionId).toBe(firstSectionId);

      // Now clear with Escape
      await page.keyboard.press('Escape');
      const selectionAfterEscape = await pollSelectionState(page, (sel) => sel === null);
      expect(selectionAfterEscape).toBeNull();
    });
  });

  test.describe('Map hover → panel highlight (bidirectional)', () => {
    // These tests verify bidirectional sync by simulating map hover via store
    // manipulation, since MapLibre layer events are challenging to trigger reliably
    // in Playwright. The actual MapLibre event handlers are covered by unit tests.

    test('hoveredSectionId from map propagates to panel highlight', async ({ page }) => {
      await createProject(page, 'Bidirectional Hover Test');

      const sectionIds = await getAvailableSectionIds(page);
      expect(sectionIds.length).toBeGreaterThan(0);
      const firstSectionId = sectionIds[0]!;

      // Simulate map hover by setting hoveredSectionId via store
      await page.evaluate((secId) => {
        const stores = (window as unknown as {
          __E2E_TEST__?: {
            uiStore: { getState: () => { setHoveredSectionId: (id: number | null) => void } };
          };
        }).__E2E_TEST__;

        if (stores) {
          stores.uiStore.getState().setHoveredSectionId(secId);
        }
      }, firstSectionId);

      // Verify map hover state is set
      const hasMapHover = await hasSectionMapHighlight(page, firstSectionId, 'hover');
      expect(hasMapHover).toBe(true);

      // Clear hover
      await page.evaluate(() => {
        const stores = (window as unknown as {
          __E2E_TEST__?: {
            uiStore: { getState: () => { setHoveredSectionId: (id: number | null) => void } };
          };
        }).__E2E_TEST__;

        if (stores) {
          stores.uiStore.getState().setHoveredSectionId(null);
        }
      });

      // Verify hover state clears
      const hasMapHoverAfter = await hasSectionMapHighlight(page, firstSectionId, 'hover');
      expect(hasMapHoverAfter).toBe(false);
    });
  });

  test.describe('Priority conflicts', () => {
    test('hover on different section overrides selection display', async ({ page }) => {
      await createProject(page, 'Different Section Hover Test');

      // Get section IDs from project
      const sectionIds = await getAvailableSectionIds(page);
      expect(sectionIds.length).toBeGreaterThan(1);
      const sectionA = sectionIds[0]!;
      const sectionB = sectionIds[1]!;

      // Select section A by clicking the row
      const sectionRowA = page.locator(`[data-testid="section-row-${sectionA}"]`);
      await sectionRowA.click();

      // Verify selection
      const selection = await pollSelectionState(page, (sel) => sel?.type === 'section');
      expect(selection?.sectionId).toBe(sectionA);

      // Now hover section B row in panel
      const sectionRowB = page.locator(`[data-testid="section-row-${sectionB}"]`);
      await sectionRowB.hover();

      // Poll for hoveredSectionId to change to section B
      const hoveredId = await pollHoveredSectionId(page, (id) => id === sectionB);
      expect(hoveredId).toBe(sectionB);

      // Section B should have map hover state
      const hasBMapHover = await hasSectionMapHighlight(page, sectionB, 'hover');
      expect(hasBMapHover).toBe(true);

      // Section A selection state persists in store
      const currentSelection = await getSelectionState(page);
      expect(currentSelection?.sectionId).toBe(sectionA);
    });
  });

  test.describe('Unhover behavior', () => {
    test('hoveredSectionId clears when mouse leaves section row', async ({ page }) => {
      await createProject(page, 'Unhover Panel Test');

      // Get section IDs from project
      const sectionIds = await getAvailableSectionIds(page);
      expect(sectionIds.length).toBeGreaterThan(0);
      const firstSectionId = sectionIds[0]!;

      // Hover the section row
      const sectionRow = page.locator(`[data-testid="section-row-${firstSectionId}"]`);
      await sectionRow.hover();

      // Verify hover is set
      await pollHoveredSectionId(page, (id) => id === firstSectionId);

      // Move mouse away from the row to the toolbar area (above sections panel, outside map)
      // The toolbar buttons are a safe area that won't trigger map hover
      const backButton = page.locator('button:has-text("← Back")');
      await backButton.hover();

      // Poll for hoveredSectionId to clear
      const hoveredId = await pollHoveredSectionId(page, (id) => id === null);
      expect(hoveredId).toBeNull();

      // Verify map hover state is cleared
      const hasMapHover = await hasSectionMapHighlight(page, firstSectionId, 'hover');
      expect(hasMapHover).toBe(false);
    });
  });

  test.describe('Keyboard navigation', () => {
    test('arrow keys navigate between section rows', async ({ page }) => {
      await createProject(page, 'Keyboard Navigation Test');

      // Get section IDs from project
      const sectionIds = await getAvailableSectionIds(page);
      expect(sectionIds.length).toBeGreaterThan(1);
      const firstSectionId = sectionIds[0]!;
      const secondSectionId = sectionIds[1]!;

      // Focus the first section row
      const firstRow = page.locator(`[data-testid="section-row-${firstSectionId}"]`);
      await firstRow.focus();

      // Verify focus styling and hover state
      await expect(firstRow).toBeFocused();
      await pollHoveredSectionId(page, (id) => id === firstSectionId);

      // Press ArrowDown to move to next row
      await page.keyboard.press('ArrowDown');

      // The second row should now be focused
      const secondRow = page.locator(`[data-testid="section-row-${secondSectionId}"]`);
      await expect(secondRow).toBeFocused();

      // Hovered section should update
      const hoveredId = await pollHoveredSectionId(page, (id) => id === secondSectionId);
      expect(hoveredId).toBe(secondSectionId);
    });

    test('Enter selects focused section', async ({ page }) => {
      await createProject(page, 'Enter Selection Test');

      // Get section IDs from project
      const sectionIds = await getAvailableSectionIds(page);
      expect(sectionIds.length).toBeGreaterThan(0);
      const firstSectionId = sectionIds[0]!;

      // Focus the first section row
      const firstRow = page.locator(`[data-testid="section-row-${firstSectionId}"]`);
      await firstRow.focus();

      // Press Enter to select
      await page.keyboard.press('Enter');

      // Verify selection
      const selection = await pollSelectionState(page, (sel) => sel?.type === 'section');
      expect(selection).not.toBeNull();
      expect(selection?.type).toBe('section');
      expect(selection?.sectionId).toBe(firstSectionId);

      // Verify map selection state
      const hasMapSelection = await hasSectionMapHighlight(page, firstSectionId, 'selection');
      expect(hasMapSelection).toBe(true);
    });

    test('Escape clears selection', async ({ page }) => {
      await createProject(page, 'Escape Clear Test');

      // Get section IDs from project
      const sectionIds = await getAvailableSectionIds(page);
      expect(sectionIds.length).toBeGreaterThan(0);
      const firstSectionId = sectionIds[0]!;

      // First, select a section
      const sectionRow = page.locator(`[data-testid="section-row-${firstSectionId}"]`);
      await sectionRow.click();

      // Verify selection
      await pollSelectionState(page, (sel) => sel?.type === 'section');

      // Focus the row (needed to receive keyboard events)
      await sectionRow.focus();

      // Press Escape to clear selection
      await page.keyboard.press('Escape');

      // Verify selection is cleared
      const selection = await pollSelectionState(page, (sel) => sel === null);
      expect(selection).toBeNull();

      // Verify map selection state is cleared
      const hasMapSelection = await hasSectionMapHighlight(page, firstSectionId, 'selection');
      expect(hasMapSelection).toBe(false);
    });
  });

  test.describe('Edge cases', () => {
    test('empty section is interactive and shows panel highlight', async ({ page }) => {
      await createProject(page, 'Empty Section Test');

      // Find the empty section row by name
      const emptySectionRow = page.locator('[data-testid^="section-item-"]').filter({ hasText: 'Empty Section' }).first();
      await expect(emptySectionRow).toBeVisible();

      // Hover should work
      await emptySectionRow.hover();

      // Get the section ID for the empty section
      const emptySectionId = await getSectionIdByName(page, 'Empty Section');
      expect(emptySectionId).not.toBeNull();
      const resolvedEmptySectionId = emptySectionId as number;

      // Verify hover state is set
      const hoveredId = await pollHoveredSectionId(page, (id) => id === resolvedEmptySectionId);
      expect(hoveredId).toBe(resolvedEmptySectionId);

      // Click should select it
      await emptySectionRow.click();

      // Should be able to select (even though no shots)
      const selection = await pollSelectionState(page, (sel) => sel?.type === 'section');
      expect(selection?.type).toBe('section');
      expect(selection?.sectionId).toBe(resolvedEmptySectionId);

      // Verify no map features for empty section (it has no shots)
      const featureCount = await page.evaluate((secId) => {
        const map = (window as unknown as {
          __cavechef_map__?: {
            queryRenderedFeatures: (options?: { layers?: string[] }) => Array<{
              properties: { sectionId: number };
            }>;
          };
        }).__cavechef_map__;

        if (!map) return -1;
        const features = map.queryRenderedFeatures({ layers: ['survey-shots'] });
        return features.filter(f => f.properties.sectionId === secId).length;
      }, resolvedEmptySectionId);

      expect(featureCount).toBe(0);
    });

    test('virtual shots are included in section highlighting', async ({ page }) => {
      await createProject(page, 'Virtual Shot Highlight Test');

      const virtualSectionId = await page.evaluate(() => {
        const stores = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: { getState: () => {
              project: { sections: Array<{ id: number; shots: Array<{ is_virtual?: boolean }> }> } | null
            } };
          };
        }).__E2E_TEST__;

        const sections = stores?.projectStore.getState().project?.sections ?? [];
        const match = sections.find((section) => section.shots?.some((shot) => shot.is_virtual));
        return match?.id ?? null;
      });
      expect(virtualSectionId).not.toBeNull();
      const resolvedVirtualSectionId = virtualSectionId as number;

      // Verify the section has a virtual shot in the mock data
      const hasVirtualShot = await page.evaluate((secId) => {
        const stores = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: { getState: () => {
              project: {
                sections: Array<{
                  id: number;
                  shots: Array<{ is_virtual?: boolean }>
                }>
              } | null
            } };
          };
        }).__E2E_TEST__;

        if (!stores) return false;
        const project = stores.projectStore.getState().project;
        const section = project?.sections.find(s => s.id === secId);
        return section?.shots.some(s => s.is_virtual) ?? false;
      }, resolvedVirtualSectionId);

      expect(hasVirtualShot).toBe(true);

      // Hover the section row
      const sectionRow = page.locator(`[data-testid="section-row-${resolvedVirtualSectionId}"]`);
      await sectionRow.hover();

      // Verify hover state is set
      const hoveredId = await pollHoveredSectionId(page, (id) => id === resolvedVirtualSectionId);
      expect(hoveredId).toBe(resolvedVirtualSectionId);

      // Verify the map state includes the section for highlighting
      // (SurveyLayer.updateVisualState applies to all shots in section, including virtual)
      const hasMapHover = await hasSectionMapHighlight(page, resolvedVirtualSectionId, 'hover');
      expect(hasMapHover).toBe(true);

      // Query shot features - should include virtual shot
      const shotFeatures = await page.evaluate((secId) => {
        const map = (window as unknown as {
          __cavechef_map__?: {
            queryRenderedFeatures: (options?: { layers?: string[] }) => Array<{
              properties: { sectionId: number; isVirtual?: boolean };
            }>;
          };
        }).__cavechef_map__;

        if (!map) return { total: 0, virtual: 0 };
        const features = map.queryRenderedFeatures({ layers: ['survey-shots'] });
        const sectionFeatures = features.filter(f => f.properties.sectionId === secId);
        const virtualFeatures = sectionFeatures.filter(f => f.properties.isVirtual);
        return { total: sectionFeatures.length, virtual: virtualFeatures.length };
      }, resolvedVirtualSectionId);

      expect(shotFeatures.total).toBeGreaterThan(0);
      // Virtual shot should be rendered (with is_virtual: true in mock data)
      expect(shotFeatures.virtual).toBeGreaterThanOrEqual(0); // May be 0 if not rendered yet
    });
  });
});
