/**
 * Helper functions for common E2E test actions in CaveChef.
 * These helpers interact with the real Tauri application through WebdriverIO.
 */

/**
 * Reset the application state - close any open dialogs and return to global view.
 * Call this in beforeEach to ensure clean test state.
 */
export async function resetAppState(): Promise<void> {
  // First ensure E2E helpers available
  await browser.waitUntil(
    async () => await browser.execute(() => !!(window as { __E2E_TEST__?: unknown }).__E2E_TEST__),
    { timeout: 5000, timeoutMsg: 'E2E helpers not available' }
  );

  // Use executeAsync with error handling
  const result = await browser.executeAsync((done: (result: { ok: boolean; error?: string }) => void) => {
    const e2e = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { closeDialog: () => void; setView: (view: string) => void }; }; projectStore: { getState: () => { closeProject: () => Promise<void> }; }; }; }).__E2E_TEST__;
    if (!e2e) {
      done({ ok: false, error: 'E2E helpers not found' });
      return;
    }

    (async () => {
      try {
        e2e.uiStore.getState().closeDialog();
        await e2e.projectStore.getState().closeProject();
        e2e.uiStore.getState().setView('global');
        done({ ok: true });
      } catch (err) {
        done({ ok: false, error: String(err) });
      }
    })();
  });

  console.log('[resetAppState] Store reset result:', result);

  // Check result and throw if failed
  if (!result.ok) {
    throw new Error(`resetAppState failed: ${result.error}`);
  }

  // Verify project is closed
  await browser.waitUntil(
    async () => await browser.execute(() => {
      const e2e = (window as unknown as { __E2E_TEST__?: { projectStore: { getState: () => { project: unknown } }; }; }).__E2E_TEST__;
      return e2e && e2e.projectStore.getState().project === null;
    }),
    { timeout: 5000, timeoutMsg: 'Project did not close' }
  );

  // Wait for GlobalView
  const globalView = await $('[data-testid="global-view"]');
  await globalView.waitForExist({ timeout: 5000 });
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

  // Wait for the new project dialog
  const dialog = await $('[role="dialog"]');
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
 * Open the DMP Import Dialog using keyboard shortcut (Ctrl+I).
 * Note: This opens DmpImportDialog, NOT ImportDialog (section creation).
 */
export async function openDmpImportDialog(): Promise<void> {
  await browser.keys(['Control', 'i']);

  // Wait for DMP import dialog to appear (use specific data-testid)
  const importDialog = await $('[data-testid="import-dmp-dialog"]');
  await importDialog.waitForDisplayed({
    timeout: 5000,
    timeoutMsg: 'DMP Import dialog did not appear',
  });
}

/**
 * Ensure Sections panel is open (don't toggle - set explicitly).
 */
export async function ensureSectionsPanelOpen(): Promise<void> {
  await browser.execute(() => {
    const e2e = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { setSectionsPanelOpen: (open: boolean) => void } }; }; }).__E2E_TEST__;
    if (e2e) {
      e2e.uiStore.getState().setSectionsPanelOpen(true);
    }
  });
  await browser.pause(100); // Let React render
}

/**
 * Open the Import Section Dialog via store (for section creation).
 * Note: This opens ImportDialog, NOT DmpImportDialog.
 */
export async function openImportSectionDialog(): Promise<void> {
  const result = await browser.execute(() => {
    const e2e = (window as unknown as { __E2E_TEST__?: { uiStore: { getState: () => { openDialog: (name: string) => void } }; }; }).__E2E_TEST__;
    if (!e2e) {
      return { success: false, error: 'E2E helpers not exposed on window. Ensure the app has loaded.' };
    }
    try {
      e2e.uiStore.getState().openDialog('import');
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  if (!result.success) {
    throw new Error(`Failed to open Import Section dialog: ${result.error}`);
  }

  // Wait for import section dialog to appear (use specific data-testid)
  const importDialog = await $('[data-testid="import-section-dialog"]');
  await importDialog.waitForDisplayed({
    timeout: 5000,
    timeoutMsg: 'Import Section dialog did not appear',
  });
}

/**
 * Press Escape key. Note: This clears tool/selection state in useKeyboardShortcuts,
 * but does NOT close dialogs (Escape support for dialogs is not yet implemented).
 * To close dialogs, use the Cancel button or backdrop click.
 */
export async function pressEscape(): Promise<void> {
  await browser.keys(['Escape']);
  // Wait for state to update
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

/**
 * Import a DMP file by providing the path directly to the store.
 * This bypasses the file dialog for E2E testing.
 * Returns the import result (DmpFile or error).
 */
export async function importDmpFile(path: string): Promise<{ success: boolean; error?: string; sectionCount?: number }> {
  return await browser.executeAsync(
    async (
      filePath: string,
      done: (result: { success: boolean; error?: string; sectionCount?: number }) => void
    ) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              importDmp: (path: string) => Promise<{ sections: unknown[] }>;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) {
        done({ success: false, error: 'E2E helpers not found' });
        return;
      }

      try {
        const result = await e2e.projectStore.getState().importDmp(filePath);
        done({ success: true, sectionCount: result.sections.length });
      } catch (err) {
        done({ success: false, error: String(err) });
      }
    },
    path
  );
}

/**
 * Open DMP import dialog and load a file using the dialog.
 * This simulates the user entering a file path directly (since we can't use the file dialog in tests).
 */
export async function openDmpImportWithFile(filePath: string): Promise<void> {
  // Open the DMP Import Dialog
  await openDmpImportDialog();

  // Set the file path directly via store and trigger load
  await browser.executeAsync(
    async (
      path: string,
      done: (result: { success: boolean; error?: string }) => void
    ) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          uiStore: {
            getState: () => {
              openDialog: (name: string, data?: unknown) => void;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) {
        done({ success: false, error: 'E2E helpers not found' });
        return;
      }

      try {
        // Re-open dialog with file path data
        e2e.uiStore.getState().openDialog('dmp-import', { filePath: path });
        done({ success: true });
      } catch (err) {
        done({ success: false, error: String(err) });
      }
    },
    filePath
  );

  // Wait for file to load (sections become visible)
  await browser.pause(2000);
}

/**
 * Get the current project state including sections.
 */
export async function getProjectSections(): Promise<Array<{ id: number; name: string; shots: unknown[] }>> {
  return await browser.executeAsync(
    (done: (sections: Array<{ id: number; name: string; shots: unknown[] }>) => void) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              project: { sections: Array<{ id: number; name: string; shots: unknown[] }> } | null;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e || !e2e.projectStore.getState().project) {
        done([]);
        return;
      }

      done(e2e.projectStore.getState().project?.sections ?? []);
    }
  );
}

/**
 * Get project statistics from the store.
 */
export async function getProjectStats(): Promise<{ totalLength: number; stationCount: number; sectionCount: number } | null> {
  return await browser.executeAsync(
    (done: (stats: { totalLength: number; stationCount: number; sectionCount: number } | null) => void) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              stats: { total_length: number; station_count: number; section_count: number } | null;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e || !e2e.projectStore.getState().stats) {
        done(null);
        return;
      }

      const stats = e2e.projectStore.getState().stats;
      if (stats) {
        done({
          totalLength: stats.total_length,
          stationCount: stats.station_count,
          sectionCount: stats.section_count,
        });
      } else {
        done(null);
      }
    }
  );
}
