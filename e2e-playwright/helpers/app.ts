import { expect, type Locator, type Page } from '@playwright/test';
import { setupTauriMocks } from '../mocks/tauri-ipc';

export interface SectionSeed {
  name: string;
  direction?: 'in' | 'out';
  color?: string;
  surveyor?: string;
  date?: string;
  shots: Array<{
    azimuth_in: number;
    azimuth_out: number;
    length: number;
    depth_in: number;
    depth_out: number;
    pitch_in?: number | null;
    pitch_out?: number | null;
    left?: number | null;
    right?: number | null;
    up?: number | null;
    down?: number | null;
    comment?: string | null;
    is_reference?: boolean;
  }>;
}

export async function setupMockedPage(page: Page): Promise<void> {
  await setupTauriMocks(page);
  await page.goto('/');
  await waitForAppReady(page);
}

export async function waitForAppReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    return Boolean(
      document.querySelector('[data-testid="global-view"]') ||
        document.querySelector('[data-testid="single-system-view"]') ||
        document.querySelector('[data-testid="map-canvas"]')
    );
  });
}

export async function waitForMapReady(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="map-canvas"][data-map-loaded="true"]', {
    timeout: 20000,
  });
  await page.waitForFunction(() => {
    const map = (window as { __stalagmight_map__?: { isStyleLoaded?: () => boolean } }).__stalagmight_map__;
    return Boolean(map && map.isStyleLoaded && map.isStyleLoaded());
  });
}

export async function waitForMapIdle(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const map = (window as { __stalagmight_map__?: { isMoving?: () => boolean } }).__stalagmight_map__;
    return Boolean(map && map.isMoving && !map.isMoving());
  });
}

export async function waitForActiveTool(page: Page, tool: string): Promise<void> {
  const mapCanvas = page.getByTestId('map-canvas');
  await expect(mapCanvas).toHaveAttribute('data-active-tool', tool);
}

export async function waitForDialogClosed(page: Page, testId: string): Promise<void> {
  const dialog = page.getByTestId(testId);
  await expect(dialog).toBeHidden();
}

export async function waitForNoDialogs(page: Page): Promise<void> {
  const visibleDialogs = page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible');
  await expect(visibleDialogs).toHaveCount(0);
}

export async function createSectionViaStore(page: Page, section: SectionSeed): Promise<void> {
  await page.evaluate(async (data) => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        projectStore: { getState: () => { createSection: (payload: unknown) => Promise<unknown> } };
      };
    }).__E2E_TEST__;

    if (!e2e) {
      throw new Error('E2E stores not available on window');
    }

    await e2e.projectStore.getState().createSection({
      name: data.name,
      surveyor: data.surveyor ?? 'Test Surveyor',
      date: data.date ?? new Date().toISOString().split('T')[0],
      color: data.color ?? '#3b82f6',
      direction: data.direction ?? 'in',
      shots: data.shots,
    });
  }, section);
}

export async function seedProjectWithSections(page: Page, sections: SectionSeed[]): Promise<void> {
  for (const section of sections) {
    await createSectionViaStore(page, section);
  }

  await page.waitForFunction((expectedCount) => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: { projectStore: { getState: () => { project: { sections: unknown[] } | null } } };
    }).__E2E_TEST__;
    return (e2e?.projectStore.getState().project?.sections?.length ?? 0) >= expectedCount;
  }, sections.length);
}

export async function clickFirstVisible(locators: Locator[]): Promise<void> {
  for (const locator of locators) {
    if (await locator.isVisible()) {
      await locator.click();
      return;
    }
  }
  throw new Error('No matching locator was visible');
}

/** Open the hamburger application menu (same trigger in global and in-project views). */
export async function openAppMenu(page: Page): Promise<void> {
  const trigger = page.getByTestId('app-menu-trigger');
  await expect(trigger).toBeVisible({ timeout: 5000 });
  if ((await trigger.getAttribute('data-dropdown-open')) === null) {
    await trigger.click();
  }
  await expect(page.getByTestId('app-menu')).toBeVisible({ timeout: 5000 });
}

/** Open the Settings dialog via the hamburger menu (global view). */
export async function openSettingsFromMenu(page: Page): Promise<void> {
  await openAppMenu(page);
  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 5000 });
}

/** Open the Debug Logs dialog via the hamburger menu (global view). */
export async function openDebugFromMenu(page: Page): Promise<void> {
  await openAppMenu(page);
  await page.getByTestId('global-debug-button').click();
}

/** Open the hamburger Import submenu and click a specific import item. */
export async function openImportFromMenu(page: Page, itemTestId: string): Promise<void> {
  await openAppMenu(page);
  await page.getByTestId('global-import-menu-button').click();
  await page.getByTestId(itemTestId).click();
}

/** Switch the recent-projects view (global view) between list and map. */
export async function switchRecentView(page: Page, view: 'list' | 'map'): Promise<void> {
  await page.getByTestId(`globalview-view-toggle-${view}`).click();
}

/**
 * Close the open project via the in-project hamburger ("Close Project"), and wait
 * for the start screen. Use when no unsaved-changes prompt is expected; for the
 * dirty path, open the menu and click `back-button` directly so you can assert
 * the unsaved-changes dialog.
 */
export async function closeProjectViaMenu(page: Page): Promise<void> {
  await openAppMenu(page);
  await page.getByTestId('back-button').click();
  // A dirty project blocks the close on an unsaved-changes dialog — discard to
  // proceed so the helper works whether or not there are unsaved edits.
  const discard = page.locator('button:has-text("Discard")');
  if (await discard.isVisible({ timeout: 1000 }).catch(() => false)) {
    await discard.click();
  }
  await expect(page.getByTestId('global-view')).toBeVisible({ timeout: 8000 });
}

/** Save the open project via the in-project hamburger ("Save"). */
export async function saveViaMenu(page: Page): Promise<void> {
  await openAppMenu(page);
  await page.getByTestId('toolbar-save-button').click();
}

/** Open the Export dialog via the in-project hamburger ("Export"). */
export async function exportFromMenu(page: Page): Promise<void> {
  await openAppMenu(page);
  await page.getByTestId('toolbar-export-button').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible({ timeout: 5000 });
}

export async function openNewProjectDialog(page: Page): Promise<void> {
  const newProjectButton = page
    .locator('[data-testid="new-project-button"], [data-testid="empty-state-new-project"]')
    .first();
  await expect(newProjectButton).toBeVisible();
  await newProjectButton.click();
  await expect(page.getByTestId('new-project-dialog')).toBeVisible();
}

export async function createProject(page: Page, name: string): Promise<void> {
  await openNewProjectDialog(page);
  await page.getByTestId('new-project-name-input').fill(name);
  await page.getByTestId('new-project-create-button').click();
  await page.getByTestId('single-system-view').waitFor({ state: 'visible', timeout: 10000 });
  await waitForMapReady(page);
}

export async function openDmpSelectionDialog(page: Page): Promise<void> {
  await page.keyboard.press('Control+i');
  await expect(page.getByTestId('dmp-selection-dialog')).toBeVisible({ timeout: 10000 });
}

export async function ensureDmpNewImportDialogVisible(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const wizard = document.querySelector('[data-testid="dmp-new-import-dialog"]');
    const placement = document.querySelector('[data-testid="placement-mode-indicator"]');
    return Boolean(wizard || placement);
  }, undefined, { timeout: 15000 });

  const wizard = page.getByTestId('dmp-new-import-dialog');
  if (await wizard.isVisible()) {
    return;
  }

  const placementIndicator = page.getByTestId('placement-mode-indicator');
  await expect(placementIndicator).toBeVisible({ timeout: 10000 });
  await page.keyboard.press('Escape');
  await expect(wizard).toBeVisible({ timeout: 10000 });
}

export async function proceedToDmpImportWizard(page: Page): Promise<void> {
  const continueButton = page.getByTestId('continue-button');
  await expect(continueButton).toBeEnabled();
  await continueButton.click();

  const zeroDatumSelection = page.getByTestId('zero-datum-selection-dialog');
  const dmpWizard = page.getByTestId('dmp-new-import-dialog');
  const placementIndicator = page.getByTestId('placement-mode-indicator');

  await page.waitForFunction(() => {
    const dialogs = [
      document.querySelector('[data-testid="zero-datum-selection-dialog"]'),
      document.querySelector('[data-testid="dmp-new-import-dialog"]'),
      document.querySelector('[data-testid="placement-mode-indicator"]'),
    ];
    return dialogs.some(Boolean);
  }, undefined, { timeout: 10000 });

  if (await zeroDatumSelection.isVisible()) {
    await zeroDatumSelection.getByTestId('zero-datum-selection-skip').click();
  }

  if (!(await dmpWizard.isVisible()) && !(await placementIndicator.isVisible())) {
    await page.waitForFunction(() => {
      return Boolean(
        document.querySelector('[data-testid="dmp-new-import-dialog"]') ||
          document.querySelector('[data-testid="placement-mode-indicator"]')
      );
    }, undefined, { timeout: 10000 });
  }

  await ensureDmpNewImportDialogVisible(page);
}

// Backward-compatible alias used by older specs.
export async function proceedToDmpSectionConfig(page: Page): Promise<void> {
  await proceedToDmpImportWizard(page);
}

export async function placeAllSections(page: Page): Promise<void> {
  await ensureDmpNewImportDialogVisible(page);

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const wizard = page.getByTestId('dmp-new-import-dialog');
    const confirm = page.getByTestId('confirm-button');
    const skip = page.getByTestId('skip-button');
    const segmentPlace = page.getByTestId('segment-place-button');
    const segmentDiscard = page.getByTestId('segment-mode-discard');
    const placeOnMap = page.getByTestId('segment-place-on-map-button');

    if (!(await wizard.isVisible())) {
      const placementIndicator = page.getByTestId('placement-mode-indicator');
      if (await placementIndicator.isVisible()) {
        await page.keyboard.press('Escape');
        await expect(wizard).toBeVisible({ timeout: 10000 });
      } else {
        return;
      }
      continue;
    }

    if (await confirm.isVisible() && await confirm.isEnabled()) {
      await confirm.click();
      continue;
    }

    if (await skip.isVisible() && await skip.isEnabled()) {
      await skip.click();
      continue;
    }

    if (await segmentPlace.isVisible() && await segmentPlace.isEnabled()) {
      await segmentPlace.click();
      continue;
    }

    if (await segmentDiscard.isVisible() && await segmentPlace.isVisible()) {
      await segmentDiscard.click();
      if (await segmentPlace.isEnabled()) {
        await segmentPlace.click();
        continue;
      }
    }

    if (await placeOnMap.isVisible() && await placeOnMap.isEnabled()) {
      await placeOnMap.click();
      const mapCanvas = page.getByTestId('map-canvas');
      await expect(mapCanvas).toBeVisible({ timeout: 10000 });
      const mapBounds = await mapCanvas.boundingBox();
      if (mapBounds) {
        await page.mouse.click(
          mapBounds.x + mapBounds.width * 0.5,
          mapBounds.y + mapBounds.height * 0.5
        );
      }
      continue;
    }

    if (await page.getByTestId('wizard-all-placed').isVisible()) {
      break;
    }

    await page.waitForTimeout(100);
  }

  const wizard = page.getByTestId('dmp-new-import-dialog');
  if (await wizard.isVisible()) {
    await page.getByTestId('cancel-button').click();
    await expect(page.getByTestId('cancel-confirm-dialog')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('confirm-cancel-button').click();
    await expect(wizard).toBeHidden({ timeout: 10000 });
  }
}

/**
 * Matches the `stalagmight-tiles` custom tile protocol in EITHER platform form.
 *
 * Tauri v2 surfaces a registered custom scheme differently per webview:
 *   - macOS/Linux (WRY):        `stalagmight-tiles://<provider>/{z}/{y}/{x}`
 *   - Windows/WebView2:         `http://stalagmight-tiles.localhost/<provider>/{z}/{y}/{x}`
 * The Vite + Chromium test environment reports the `http://…localhost/` form. Both
 * are served by the same registered Rust protocol handler (`src-tauri/src/lib.rs`
 * `register_asynchronous_uri_scheme_protocol("stalagmight-tiles", …)`) — neither is
 * a raw network fetch. This regex intentionally accepts only those two forms, so a
 * real external tile server (`https://server.arcgisonline.com/…`) still fails the
 * assertion (the original CORS-bug guard these satellite tests were written for).
 */
export const CUSTOM_TILE_URL_RE =
  /^(?:stalagmight-tiles:\/\/|http:\/\/stalagmight-tiles\.localhost\/)/;
