/**
 * Helper functions for common E2E test actions in CaveChef.
 * These helpers interact with the real Tauri application through WebdriverIO.
 */

/**
 * Wait for the application to be fully loaded and ready.
 * Checks for the main app container to be present.
 */
export async function waitForAppReady(): Promise<void> {
  // Wait for the React app to mount
  await browser.waitUntil(
    async () => {
      const appElement = await $('[data-testid="app-container"]');
      if (!await appElement.isExisting()) {
        // Fallback: check for any main container
        const fallback = await $('main, #root > div');
        return await fallback.isExisting();
      }
      return true;
    },
    {
      timeout: 30000,
      timeoutMsg: 'Application did not load within 30 seconds',
    }
  );
}

/**
 * Create a new project with the given name.
 */
export async function createNewProject(projectName: string): Promise<void> {
  // Click the "New Project" button on the landing page
  const newProjectBtn = await $('button*=New Project');
  await newProjectBtn.waitForClickable({ timeout: 10000 });
  await newProjectBtn.click();

  // Wait for the new project dialog
  const dialog = await $('[role="dialog"]');
  await dialog.waitForDisplayed({ timeout: 5000 });

  // Fill in the project name
  const nameInput = await $('input[placeholder*="name"], input[name="projectName"]');
  await nameInput.waitForEnabled({ timeout: 5000 });
  await nameInput.setValue(projectName);

  // Click Create button
  const createBtn = await $('button*=Create');
  await createBtn.waitForClickable({ timeout: 5000 });
  await createBtn.click();

  // Wait for SingleSystemView to appear (indicates project was created)
  await browser.waitUntil(
    async () => {
      const map = await $('canvas, [class*="map"], [class*="SingleSystemView"]');
      return await map.isExisting();
    },
    {
      timeout: 10000,
      timeoutMsg: 'SingleSystemView did not appear after creating project',
    }
  );
}

/**
 * Open the Import Dialog using keyboard shortcut.
 */
export async function openImportDialog(): Promise<void> {
  await browser.keys(['Control', 'i']);

  // Wait for import dialog to appear
  const importDialog = await $('[role="dialog"]');
  await importDialog.waitForDisplayed({
    timeout: 5000,
    timeoutMsg: 'Import dialog did not appear',
  });
}

/**
 * Close any open dialog by pressing Escape.
 */
export async function closeDialog(): Promise<void> {
  await browser.keys(['Escape']);
  // Wait for dialog to disappear
  await browser.pause(500);
}

/**
 * Save the current project using keyboard shortcut.
 */
export async function saveProject(): Promise<void> {
  await browser.keys(['Control', 's']);
  // Wait a moment for save to complete
  await browser.pause(1000);
}

/**
 * Trigger undo action.
 */
export async function undo(): Promise<void> {
  await browser.keys(['Control', 'z']);
  await browser.pause(300);
}

/**
 * Trigger redo action.
 */
export async function redo(): Promise<void> {
  await browser.keys(['Control', 'y']);
  await browser.pause(300);
}

/**
 * Switch to a specific map tool by keyboard shortcut.
 */
export async function selectTool(
  tool: 'select' | 'pan' | 'zoom' | 'draw' | 'delete' | 'merge' | 'measure' | 'moveSection' | 'moveStation'
): Promise<void> {
  const toolKeys: Record<string, string> = {
    select: 's',
    pan: 'p',
    zoom: 'z',
    draw: 'd',
    delete: 'x',
    merge: 'm',
    measure: 'r',
    moveSection: 'v',
    moveStation: 't',
  };

  await browser.keys([toolKeys[tool] ?? 's']);
  await browser.pause(200);
}

/**
 * Toggle a panel visibility.
 */
export async function togglePanel(panel: 'sections' | 'detail' | 'dataTable'): Promise<void> {
  const panelKeys: Record<string, string> = {
    sections: '1',
    detail: '2',
    dataTable: '3',
  };

  await browser.keys(['Control', panelKeys[panel] ?? '1']);
  await browser.pause(300);
}

/**
 * Fill in shot data in the Import Dialog.
 */
export async function addShotToImport(shot: {
  azimuth: number;
  length: number;
  depth: number;
  left?: number;
  right?: number;
  up?: number;
  down?: number;
}): Promise<void> {
  // Find the shot entry fields (assuming table-like input)
  const azimuthInput = await $('input[name*="azimuth"], input[placeholder*="azimuth"]');
  await azimuthInput.setValue(shot.azimuth.toString());

  const lengthInput = await $('input[name*="length"], input[placeholder*="length"]');
  await lengthInput.setValue(shot.length.toString());

  const depthInput = await $('input[name*="depth"], input[placeholder*="depth"]');
  await depthInput.setValue(shot.depth.toString());

  // Optional LRUD values
  if (shot.left !== undefined) {
    const leftInput = await $('input[name*="left"], input[placeholder*="L"]');
    if (await leftInput.isExisting()) {
      await leftInput.setValue(shot.left.toString());
    }
  }

  if (shot.right !== undefined) {
    const rightInput = await $('input[name*="right"], input[placeholder*="R"]');
    if (await rightInput.isExisting()) {
      await rightInput.setValue(shot.right.toString());
    }
  }

  if (shot.up !== undefined) {
    const upInput = await $('input[name*="up"], input[placeholder*="U"]');
    if (await upInput.isExisting()) {
      await upInput.setValue(shot.up.toString());
    }
  }

  if (shot.down !== undefined) {
    const downInput = await $('input[name*="down"], input[placeholder*="D"]');
    if (await downInput.isExisting()) {
      await downInput.setValue(shot.down.toString());
    }
  }
}

/**
 * Get text content from statistics footer in Import Dialog.
 */
export async function getImportStatistics(): Promise<{
  totalLength?: string;
  depthRange?: string;
  shotCount?: string;
}> {
  const stats: {
    totalLength?: string;
    depthRange?: string;
    shotCount?: string;
  } = {};

  try {
    const totalLengthEl = await $('[data-testid="stats-total-length"]');
    if (await totalLengthEl.isExisting()) {
      stats.totalLength = await totalLengthEl.getText();
    }

    const depthRangeEl = await $('[data-testid="stats-depth-range"]');
    if (await depthRangeEl.isExisting()) {
      stats.depthRange = await depthRangeEl.getText();
    }

    const shotCountEl = await $('[data-testid="stats-shot-count"]');
    if (await shotCountEl.isExisting()) {
      stats.shotCount = await shotCountEl.getText();
    }
  } catch {
    // Stats elements may not exist
  }

  return stats;
}

/**
 * Click the Import button to confirm import.
 */
export async function confirmImport(): Promise<void> {
  const importBtn = await $('button*=Import');
  await importBtn.waitForClickable({ timeout: 5000 });
  await importBtn.click();

  // Wait for dialog to close
  await browser.waitUntil(
    async () => {
      const dialog = await $('[role="dialog"]');
      return !(await dialog.isDisplayed());
    },
    {
      timeout: 10000,
      timeoutMsg: 'Import dialog did not close after import',
    }
  );
}

/**
 * Check if an element with specific text exists on the page.
 */
export async function elementWithTextExists(text: string): Promise<boolean> {
  const element = await $(`//*[contains(text(), "${text}")]`);
  return await element.isExisting();
}
