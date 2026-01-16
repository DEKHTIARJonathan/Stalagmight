/**
 * Helper functions for common E2E test actions in CaveChef.
 * These helpers interact with the real Tauri application through WebdriverIO.
 */

/**
 * Reset the application state - close any open dialogs and return to global view.
 * Call this in beforeEach to ensure clean test state.
 */
export async function resetAppState(): Promise<void> {
  // Try to close any open dialogs by pressing Escape multiple times
  for (let i = 0; i < 3; i++) {
    await browser.keys(['Escape']);
    await browser.pause(100);
  }

  // Use exposed store to reset to GlobalView if available
  const result = await browser.execute(() => {
    const e2e = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { setView: (view: string) => void }; }; projectStore: { getState: () => { closeProject: () => void }; }; }; }).__E2E_TEST__;
    if (e2e) {
      try {
        // Close any open project and return to global view
        e2e.projectStore.getState().closeProject();
        e2e.uiStore.getState().setView('global');
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
    return { success: false, error: 'E2E helpers not available' };
  });

  console.log('[resetAppState] Store reset result:', result);

  // Wait a moment for state to settle
  await browser.pause(500);

  // Verify we're back at GlobalView
  await browser.waitUntil(
    async () => {
      const globalView = await $('[data-testid="global-view"]');
      return await globalView.isExisting();
    },
    {
      timeout: 5000,
      timeoutMsg: 'Failed to return to GlobalView after reset',
    }
  );
}

/**
 * Wait for the application to be fully loaded and ready.
 * Checks for the main app container to be present.
 */
export async function waitForAppReady(): Promise<void> {
  // Wait for the React app to mount - give it extra time to initialize
  await browser.pause(1000);

  await browser.waitUntil(
    async () => {
      // Check for GlobalView (start page) or SingleSystemView (project open)
      const globalView = await $('[data-testid="global-view"]');
      if (await globalView.isExisting()) {
        return true;
      }
      // Check for New Project button as another indicator
      const newProjectBtn = await $('button*=New Project');
      if (await newProjectBtn.isExisting()) {
        return true;
      }
      // Fallback: check for canvas (SingleSystemView)
      const canvas = await $('canvas');
      return await canvas.isExisting();
    },
    {
      timeout: 30000,
      timeoutMsg: 'Application did not load within 30 seconds',
    }
  );

  // Extra pause for React to finish rendering
  await browser.pause(500);
}

/**
 * Click an element using JavaScript (fallback for WebKit issues).
 * Uses a full synthetic MouseEvent to properly trigger React event handlers.
 */
async function jsClick(element: WebdriverIO.Element): Promise<void> {
  await browser.execute((el) => {
    const htmlEl = el as HTMLElement;
    // Create a complete synthetic MouseEvent that React will recognize
    const event = new MouseEvent('click', {
      view: window,
      bubbles: true,
      cancelable: true,
      buttons: 1,
    });
    htmlEl.dispatchEvent(event);
  }, element);
}

/**
 * Create a new project with the given name.
 */
export async function createNewProject(projectName: string): Promise<void> {
  // Click the "New Project" button on the landing page
  // Try data-testid first, fallback to text selector
  let newProjectBtn = await $('[data-testid="new-project-button"]');
  const hasTestId = await newProjectBtn.isExisting();
  console.log('[createNewProject] Button with data-testid exists:', hasTestId);

  if (!hasTestId) {
    newProjectBtn = await $('button*=New Project');
    console.log('[createNewProject] Fallback to text selector');
  }

  // Wait for button to exist and be visible
  await newProjectBtn.waitForDisplayed({ timeout: 10000 });
  console.log('[createNewProject] Button is displayed');

  // Log button properties for debugging
  const btnText = await newProjectBtn.getText();
  const btnEnabled = await newProjectBtn.isEnabled();
  console.log('[createNewProject] Button text:', btnText, 'enabled:', btnEnabled);

  // Wait for E2E test helpers to be available
  console.log('[createNewProject] Waiting for E2E helpers...');
  await browser.waitUntil(
    async () => {
      const hasHelpers = await browser.execute(() => {
        return !!(window as { __E2E_TEST__?: unknown }).__E2E_TEST__;
      });
      return hasHelpers;
    },
    {
      timeout: 10000,
      timeoutMsg: 'E2E helpers not available on window',
    }
  );

  // Use exposed E2E test helpers to open the dialog directly
  console.log('[createNewProject] Opening dialog via exposed store...');
  const storeResult = await browser.execute(() => {
    // Access the exposed Zustand stores
    const e2e = (window as { __E2E_TEST__?: { uiStore: { getState: () => { openDialog: (name: string) => void } } } }).__E2E_TEST__;
    if (!e2e) {
      return { success: false, error: 'E2E helpers not exposed on window' };
    }

    // Call openDialog directly on the store
    try {
      e2e.uiStore.getState().openDialog('new-project');
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
  console.log('[createNewProject] Store result:', storeResult);

  // Wait for React to process the click and open dialog
  await browser.pause(2000);

  // Check what's on the page
  const pageHtml = await browser.execute(() => document.body.innerHTML.substring(0, 2000));
  console.log('[createNewProject] Page HTML after click:', pageHtml);

  // Wait for the new project dialog
  const dialog = await $('[role="dialog"]');
  const dialogExists = await dialog.isExisting();
  console.log('[createNewProject] Dialog exists:', dialogExists);
  if (dialogExists) {
    const dialogDisplayed = await dialog.isDisplayed();
    console.log('[createNewProject] Dialog displayed:', dialogDisplayed);
  }
  await dialog.waitForDisplayed({ timeout: 15000 });

  // Fill in the project name - look for the first text input in the dialog
  const nameInput = await dialog.$('input[type="text"]');
  await nameInput.waitForEnabled({ timeout: 5000 });
  await nameInput.setValue(projectName);

  // Click Create button - use JS click for reliability
  const createBtn = await dialog.$('button*=Create');
  await createBtn.waitForDisplayed({ timeout: 5000 });
  try {
    await createBtn.waitForClickable({ timeout: 3000 });
    await createBtn.click();
  } catch {
    await jsClick(createBtn);
  }

  // Wait for SingleSystemView to appear (indicates project was created)
  await browser.waitUntil(
    async () => {
      const map = await $('canvas, [class*="map"], [class*="SingleSystemView"]');
      return await map.isExisting();
    },
    {
      timeout: 15000,
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
