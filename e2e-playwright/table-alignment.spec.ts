import { test, expect, Page } from '@playwright/test';
import {
  setupMockedPage,
  createProject,
  seedProjectWithSections,
  waitForMapReady,
  waitForNoDialogs,
  waitForMapIdle,
  type SectionSeed,
} from './helpers/app';

const sectionSeeds: SectionSeed[] = [
  {
    name: 'Alignment Test',
    direction: 'in',
    shots: [
      {
        azimuth_in: 45,
        azimuth_out: 225,
        length: 10.5,
        depth_in: -2,
        depth_out: -2.5,
        left: 1.5,
        right: 2.3,
        up: 3.0,
        down: 0.8,
        comment: 'Test comment',
      },
      {
        azimuth_in: 90,
        azimuth_out: 270,
        length: 15.2,
        depth_in: -2.5,
        depth_out: -5.0,
        left: 0.5,
        right: 0.7,
        up: 1.2,
        down: 1.5,
        comment: null,
      },
    ],
  },
];

async function createProjectWithSections(page: Page): Promise<void> {
  await createProject(page, 'Alignment Test Project');
  await seedProjectWithSections(page, sectionSeeds);
  await waitForMapReady(page);
  await waitForNoDialogs(page);
  await waitForMapIdle(page);
}

async function openEditSectionDialog(page: Page): Promise<void> {
  const sectionId = await page.evaluate(() => {
    const project = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: { getState: () => { project: { sections: Array<{ id: number; name: string }> } | null } };
      };
    }).__E2E_TEST__?.projectStore.getState().project;

    return project?.sections.find((s) => s.name === 'Alignment Test')?.id ?? null;
  });

  if (sectionId === null) {
    throw new Error('Section not found: Alignment Test');
  }

  await page.evaluate((id) => {
    const uiStore = (window as unknown as {
      __E2E_TEST__?: { uiStore: { getState: () => { openDialog: (dialog: string, data?: Record<string, unknown>) => void } } };
    }).__E2E_TEST__?.uiStore;

    if (!uiStore) return;

    uiStore.getState().openDialog('edit-section', { sectionId: id });
  }, sectionId);

  await expect(page.getByTestId('edit-section-dialog')).toBeVisible({ timeout: 5000 });
}

test.describe('Table Numeric Column Alignment', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockedPage(page);
    await createProjectWithSections(page);
  });

  test('numeric column headers should be right-aligned in ShotTableEditor', async ({ page }) => {
    await openEditSectionDialog(page);

    const table = page.getByTestId('shot-table');
    await expect(table).toBeVisible();

    const headers = table.locator('thead th');
    const headerCount = await headers.count();

    // Collect header texts and their alignment
    const headerInfo: Array<{ text: string; align: string }> = [];
    for (let i = 0; i < headerCount; i++) {
      const th = headers.nth(i);
      const text = (await th.textContent())?.trim() ?? '';
      const align = await th.evaluate((el) => getComputedStyle(el).textAlign);
      headerInfo.push({ text, align });
    }

    // Numeric columns should be right-aligned
    const numericHeaders = ['Length', 'Azimuth', 'Depth In', 'Depth Out', 'L', 'R', 'U', 'D'];
    for (const name of numericHeaders) {
      const header = headerInfo.find((h) => h.text === name);
      expect(header, `Header "${name}" should exist`).toBeDefined();
      expect(header!.align).toBe('right');
    }

    // Text columns should be left-aligned (browsers may report 'start' or 'left')
    const textHeaders = ['#', 'Comment'];
    for (const name of textHeaders) {
      const header = headerInfo.find((h) => h.text === name);
      expect(header, `Header "${name}" should exist`).toBeDefined();
      expect(['left', 'start']).toContain(header!.align);
    }
  });

  test('numeric input cells should be right-aligned in ShotTableEditor', async ({ page }) => {
    await openEditSectionDialog(page);

    const dialog = page.getByTestId('edit-section-dialog');
    await expect(dialog).toBeVisible();

    // Numeric inputs should have text-align: right
    const numericInputIds = [
      'shot-length-0',
      'shot-azimuth-0',
      'shot-depth-in-0',
      'shot-depth-out-0',
      'shot-left-0',
      'shot-right-0',
      'shot-up-0',
      'shot-down-0',
    ];

    for (const testId of numericInputIds) {
      const input = dialog.getByTestId(testId);
      await expect(input).toBeVisible();
      await expect(input).toHaveCSS('text-align', 'right');
    }

    // Comment input should be left-aligned (default); browsers may report 'start' or 'left'
    const commentInput = dialog.getByTestId('shot-comment-0');
    await expect(commentInput).toBeVisible();
    const commentAlign = await commentInput.evaluate((el) => getComputedStyle(el).textAlign);
    expect(['left', 'start']).toContain(commentAlign);
  });

  test('numeric inputs should use tabular-nums font variant', async ({ page }) => {
    await openEditSectionDialog(page);

    const dialog = page.getByTestId('edit-section-dialog');
    await expect(dialog).toBeVisible();

    // Check font-variant-numeric on a representative numeric input
    const lengthInput = dialog.getByTestId('shot-length-0');
    await expect(lengthInput).toBeVisible();
    await expect(lengthInput).toHaveCSS('font-variant-numeric', 'tabular-nums');

    const azimuthInput = dialog.getByTestId('shot-azimuth-0');
    await expect(azimuthInput).toHaveCSS('font-variant-numeric', 'tabular-nums');
  });

  test('warnings column header should be center-aligned', async ({ page }) => {
    await openEditSectionDialog(page);

    const table = page.getByTestId('shot-table');
    await expect(table).toBeVisible();

    // The warnings column has no text content but should be center-aligned
    // It's the second-to-last th with title="Warnings"
    const warningsHeader = table.locator('thead th[title="Warnings"]');
    await expect(warningsHeader).toHaveCSS('text-align', 'center');
  });
});
