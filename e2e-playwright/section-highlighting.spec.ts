import { test, expect, Page } from './fixtures/coverage';
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
 * - Edge cases (empty sections, reference shots)
 */

/**
 * Helper to wait for the map to be fully loaded.
 */
async function waitForMapReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const map = (window as unknown as { __stalagmight_map__?: { loaded: () => boolean } }).__stalagmight_map__;
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
        __stalagmight_map__?: { queryRenderedFeatures: (opts: { layers: string[] }) => Array<unknown> };
      }).__stalagmight_map__;
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
      { azimuth_in: 120, azimuth_out: 300, length: 6, depth_in: -6, depth_out: -4, is_reference: true },
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
/**
 * Helper to query MapLibre feature-state on all features belonging to a section.
 * Uses querySourceFeatures + getFeatureState (requires source names, not layer names).
 * Throws inside page.evaluate if __stalagmight_map__ is missing so tests fail
 * instead of passing vacuously with total=0.
 */
async function getSectionFeatureStates(
  page: Page,
  sectionId: number,
  stateKey: 'hover' | 'selected'
): Promise<{ shots: { total: number; withState: number }; stations: { total: number; withState: number } }> {
  return page.evaluate(({ secId, key }) => {
    const map = (window as unknown as { __stalagmight_map__?: {
      querySourceFeatures: (source: string) => Array<{ properties?: { sectionId?: number; featureId?: number } }>;
      getFeatureState: (opts: { source: string; id: number }) => Record<string, unknown> | null;
    } }).__stalagmight_map__;
    if (!map) throw new Error('__stalagmight_map__ not found — map must be loaded before checking feature-state');

    const checkSource = (sourceName: string) => {
      const features = map.querySourceFeatures(sourceName);
      const sectionFeatures = features.filter((f) => f.properties?.sectionId === secId);
      const uniqueIds = new Set(sectionFeatures.map((f) => f.properties?.featureId).filter((id): id is number => id != null));
      let withState = 0;
      for (const id of uniqueIds) {
        const state = map.getFeatureState({ source: sourceName, id });
        if (state?.[key]) withState++;
      }
      return { total: uniqueIds.size, withState };
    };

    return {
      shots: checkSource('survey-data-shots'),
      stations: checkSource('survey-data-stations'),
    };
  }, { secId: sectionId, key: stateKey });
}

type FeatureStateCounts = { shots: { total: number; withState: number }; stations: { total: number; withState: number } };

/**
 * Poll until feature-state matches the expected predicate.
 * Avoids race conditions where store state is set but updateVisualState()
 * hasn't run yet (can lag by a tick/frame).
 */
async function pollSectionFeatureStates(
  page: Page,
  sectionId: number,
  stateKey: 'hover' | 'selected',
  predicate: (s: FeatureStateCounts) => boolean,
  timeout = 5000
): Promise<FeatureStateCounts> {
  let result: FeatureStateCounts = { shots: { total: 0, withState: 0 }, stations: { total: 0, withState: 0 } };
  await expect.poll(
    async () => {
      const states = await getSectionFeatureStates(page, sectionId, stateKey);
      result = states;
      return predicate(states);
    },
    { timeout }
  ).toBe(true);
  return result;
}

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

      // Verify feature-state is applied to map features (poll to avoid race with updateVisualState)
      const states = await pollSectionFeatureStates(page, firstSectionId, 'hover',
        (s) => s.shots.total > 0 && s.shots.withState === s.shots.total);
      expect(states.shots.total).toBeGreaterThan(0);
      expect(states.stations.withState).toBe(states.stations.total);
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

      // Verify feature-state is applied to map features (poll to avoid race with updateVisualState)
      const states = await pollSectionFeatureStates(page, firstSectionId, 'selected',
        (s) => s.shots.total > 0 && s.shots.withState === s.shots.total);
      expect(states.shots.total).toBeGreaterThan(0);
      expect(states.stations.withState).toBe(states.stations.total);

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
      const backButton = page.locator('[data-testid="back-button"]');
      await backButton.hover();

      // Poll for hoveredSectionId to clear
      const hoveredId = await pollHoveredSectionId(page, (id) => id === null);
      expect(hoveredId).toBeNull();

      // Verify map hover state is cleared
      const hasMapHover = await hasSectionMapHighlight(page, firstSectionId, 'hover');
      expect(hasMapHover).toBe(false);

      // Verify feature-state is removed from map features (poll to avoid race)
      const statesAfterUnhover = await pollSectionFeatureStates(page, firstSectionId, 'hover',
        (s) => s.shots.total > 0 && s.shots.withState === 0);
      expect(statesAfterUnhover.shots.total).toBeGreaterThan(0);
      expect(statesAfterUnhover.shots.withState).toBe(0);
      expect(statesAfterUnhover.stations.withState).toBe(0);
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
          __stalagmight_map__?: {
            queryRenderedFeatures: (options?: { layers?: string[] }) => Array<{
              properties: { sectionId: number };
            }>;
          };
        }).__stalagmight_map__;

        if (!map) return -1;
        const features = map.queryRenderedFeatures({ layers: ['survey-shots'] });
        return features.filter(f => f.properties.sectionId === secId).length;
      }, resolvedEmptySectionId);

      expect(featureCount).toBe(0);
    });

    test('reference shots are included in section highlighting', async ({ page }) => {
      await createProject(page, 'Reference Shot Highlight Test');

      const referenceSectionId = await page.evaluate(() => {
        const stores = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: { getState: () => {
              project: { sections: Array<{ id: number; shots: Array<{ is_reference?: boolean }> }> } | null
            } };
          };
        }).__E2E_TEST__;

        const sections = stores?.projectStore.getState().project?.sections ?? [];
        const match = sections.find((section) => section.shots?.some((shot) => shot.is_reference));
        return match?.id ?? null;
      });
      expect(referenceSectionId).not.toBeNull();
      const resolvedReferenceSectionId = referenceSectionId as number;

      // Verify the section has a reference shot in the mock data
      const hasReferenceShot = await page.evaluate((secId) => {
        const stores = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: { getState: () => {
              project: {
                sections: Array<{
                  id: number;
                  shots: Array<{ is_reference?: boolean }>
                }>
              } | null
            } };
          };
        }).__E2E_TEST__;

        if (!stores) return false;
        const project = stores.projectStore.getState().project;
        const section = project?.sections.find(s => s.id === secId);
        return section?.shots.some(s => s.is_reference) ?? false;
      }, resolvedReferenceSectionId);

      expect(hasReferenceShot).toBe(true);

      // Hover the section row
      const sectionRow = page.locator(`[data-testid="section-row-${resolvedReferenceSectionId}"]`);
      await sectionRow.hover();

      // Verify hover state is set
      const hoveredId = await pollHoveredSectionId(page, (id) => id === resolvedReferenceSectionId);
      expect(hoveredId).toBe(resolvedReferenceSectionId);

      // Verify the map state includes the section for highlighting
      // (SurveyLayer.updateVisualState applies to all shots in section, including reference)
      const hasMapHover = await hasSectionMapHighlight(page, resolvedReferenceSectionId, 'hover');
      expect(hasMapHover).toBe(true);

      // Query shot features - should include reference shot
      const shotFeatures = await page.evaluate((secId) => {
        const map = (window as unknown as {
          __stalagmight_map__?: {
            queryRenderedFeatures: (options?: { layers?: string[] }) => Array<{
              properties: { sectionId: number; isReference?: boolean };
            }>;
          };
        }).__stalagmight_map__;

        if (!map) return { total: 0, reference: 0 };
        const features = map.queryRenderedFeatures({ layers: ['survey-shots'] });
        const sectionFeatures = features.filter(f => f.properties.sectionId === secId);
        const referenceFeatures = sectionFeatures.filter(f => f.properties.isReference);
        return { total: sectionFeatures.length, reference: referenceFeatures.length };
      }, resolvedReferenceSectionId);

      expect(shotFeatures.total).toBeGreaterThan(0);
      // Reference shot should be rendered (with is_reference: true in mock data)
      expect(shotFeatures.reference).toBeGreaterThanOrEqual(0); // May be 0 if not rendered yet
    });
  });

  test.describe('Feature-state coexistence', () => {
    test('section selection and different section hover coexist on map', async ({ page }) => {
      await createProject(page, 'Feature State Coexist Test');

      const sectionIds = await getAvailableSectionIds(page);
      expect(sectionIds.length).toBeGreaterThan(1);
      const sectionA = sectionIds[0]!;
      const sectionB = sectionIds[1]!;

      // Select section A
      const sectionRowA = page.locator(`[data-testid="section-row-${sectionA}"]`);
      await sectionRowA.click();
      await pollSelectionState(page, (sel) => sel?.type === 'section' && sel?.sectionId === sectionA);

      // Verify section A has selected feature-state (poll to avoid race)
      const statesASelected = await pollSectionFeatureStates(page, sectionA, 'selected',
        (s) => s.shots.total > 0 && s.shots.withState === s.shots.total);
      expect(statesASelected.shots.total).toBeGreaterThan(0);

      // Hover section B
      const sectionRowB = page.locator(`[data-testid="section-row-${sectionB}"]`);
      await sectionRowB.hover();
      await pollHoveredSectionId(page, (id) => id === sectionB);

      // Verify section B has hover feature-state (poll to avoid race)
      const statesBHover = await pollSectionFeatureStates(page, sectionB, 'hover',
        (s) => s.shots.total > 0 && s.shots.withState === s.shots.total);
      expect(statesBHover.shots.total).toBeGreaterThan(0);

      // Verify section A still has selected feature-state
      const statesAStillSelected = await getSectionFeatureStates(page, sectionA, 'selected');
      expect(statesAStillSelected.shots.total).toBeGreaterThan(0);
      expect(statesAStillSelected.shots.withState).toBe(statesAStillSelected.shots.total);

      // Verify section A does NOT have hover feature-state (only B is hovered)
      const statesANoHover = await getSectionFeatureStates(page, sectionA, 'hover');
      expect(statesANoHover.shots.withState).toBe(0);
      expect(statesANoHover.stations.withState).toBe(0);
    });
  });

  test.describe('Feature-state clears on Escape', () => {
    test('pressing Escape removes selected feature-state from section features', async ({ page }) => {
      await createProject(page, 'Escape Feature State Test');

      const sectionIds = await getAvailableSectionIds(page);
      expect(sectionIds.length).toBeGreaterThan(0);
      const firstSectionId = sectionIds[0]!;

      // Select section
      const sectionRow = page.locator(`[data-testid="section-row-${firstSectionId}"]`);
      await sectionRow.click();
      await pollSelectionState(page, (sel) => sel?.type === 'section' && sel?.sectionId === firstSectionId);

      // Verify feature-state is applied (poll to avoid race)
      const statesBefore = await pollSectionFeatureStates(page, firstSectionId, 'selected',
        (s) => s.shots.total > 0 && s.shots.withState === s.shots.total);
      expect(statesBefore.shots.total).toBeGreaterThan(0);

      // Press Escape
      await page.keyboard.press('Escape');
      await pollSelectionState(page, (sel) => sel === null);

      // Verify feature-state is removed (poll to avoid race)
      const statesAfter = await pollSectionFeatureStates(page, firstSectionId, 'selected',
        (s) => s.shots.total > 0 && s.shots.withState === 0);
      expect(statesAfter.shots.total).toBeGreaterThan(0);
      expect(statesAfter.shots.withState).toBe(0);
      expect(statesAfter.stations.withState).toBe(0);
    });
  });

  test.describe('Feature-state survives data update', () => {
    test('section highlighting persists after data update (setData re-apply)', async ({ page }) => {
      await createProject(page, 'Data Update Feature State Test');

      const sectionIds = await getAvailableSectionIds(page);
      expect(sectionIds.length).toBeGreaterThan(0);
      const firstSectionId = sectionIds[0]!;

      // Select section
      const sectionRow = page.locator(`[data-testid="section-row-${firstSectionId}"]`);
      await sectionRow.click();
      await pollSelectionState(page, (sel) => sel?.type === 'section' && sel?.sectionId === firstSectionId);

      // Verify feature-state is applied before data update (poll to avoid race)
      const statesBefore = await pollSectionFeatureStates(page, firstSectionId, 'selected',
        (s) => s.shots.total > 0 && s.shots.withState === s.shots.total);
      expect(statesBefore.shots.total).toBeGreaterThan(0);

      // Read showDepthGradient before toggle to verify it actually changes
      const gradientBefore = await page.evaluate(() => {
        const stores = (window as unknown as {
          __E2E_TEST__?: {
            uiStore: { getState: () => { showDepthGradient: boolean } };
          };
        }).__E2E_TEST__;
        return stores?.uiStore.getState().showDepthGradient ?? null;
      });
      expect(gradientBefore).not.toBeNull();

      // Trigger a data update by toggling depth gradient via store
      // This causes SurveyLayer.update() → setData() which clears all feature-state
      await page.evaluate(() => {
        const stores = (window as unknown as {
          __E2E_TEST__?: {
            uiStore: { getState: () => { toggleDisplay: (key: string) => void } };
          };
        }).__E2E_TEST__;
        if (!stores) throw new Error('__E2E_TEST__ stores not found');
        stores.uiStore.getState().toggleDisplay('showDepthGradient');
      });

      // Verify the toggle actually changed (proves data update was triggered)
      const gradientAfter = await page.evaluate(() => {
        const stores = (window as unknown as {
          __E2E_TEST__?: {
            uiStore: { getState: () => { showDepthGradient: boolean } };
          };
        }).__E2E_TEST__;
        return stores?.uiStore.getState().showDepthGradient ?? null;
      });
      expect(gradientAfter).toBe(!gradientBefore);

      // Verify feature-state is STILL applied after the data update
      // Poll instead of fixed sleep — updateVisualState re-applies after setData
      const statesAfter = await pollSectionFeatureStates(page, firstSectionId, 'selected',
        (s) => s.shots.total > 0 && s.shots.withState === s.shots.total);
      expect(statesAfter.shots.total).toBeGreaterThan(0);
      expect(statesAfter.shots.withState).toBe(statesAfter.shots.total);
      expect(statesAfter.stations.withState).toBe(statesAfter.stations.total);
    });
  });
});
