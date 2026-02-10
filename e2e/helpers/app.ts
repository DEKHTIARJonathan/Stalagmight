/**
 * Helper functions for common E2E test actions in Stalagmight.
 * These helpers interact with the real Tauri application through WebdriverIO.
 */

/**
 * Get the current map zoom level.
 * @returns The current zoom level, or 0 if map is not available.
 */
export async function getMapZoom(): Promise<number> {
  return browser.execute(() => {
    const map = (window as unknown as { __stalagmight_map__?: { getZoom: () => number } }).__stalagmight_map__;
    return map?.getZoom() ?? 0;
  });
}

/**
 * Load a project fixture by name.
 * Creates a new project with pre-defined survey data for testing.
 *
 * Available fixtures:
 * - 'basic-survey': A simple survey with two sections containing basic shots
 *
 * @param fixtureName - The name of the fixture to load
 */
export async function loadProjectFixture(fixtureName: string): Promise<void> {
  // Wait for E2E test helpers to be available
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

  // Define fixtures
  const fixtures: Record<string, {
    projectName: string;
    sections: Array<{
      name: string;
      color: string;
      shots: Array<{
        azimuth_in: number;
        azimuth_out: number;
        length: number;
        depth_in: number;
        depth_out: number;
      }>;
    }>;
  }> = {
    'basic-survey': {
      projectName: 'Basic Survey Test',
      sections: [
        {
          name: 'Main Passage',
          color: '#FF6B6B',
          shots: [
            { azimuth_in: 45, azimuth_out: 45, length: 10, depth_in: 0, depth_out: -1 },
            { azimuth_in: 90, azimuth_out: 90, length: 15, depth_in: -1, depth_out: -2 },
            { azimuth_in: 60, azimuth_out: 60, length: 8, depth_in: -2, depth_out: -3 },
          ],
        },
        {
          name: 'Side Branch',
          color: '#4ECDC4',
          shots: [
            { azimuth_in: 120, azimuth_out: 120, length: 5, depth_in: -1, depth_out: -1.5 },
            { azimuth_in: 150, azimuth_out: 150, length: 7, depth_in: -1.5, depth_out: -2 },
          ],
        },
      ],
    },
  };

  const fixture = fixtures[fixtureName];
  if (!fixture) {
    throw new Error(`Unknown fixture: ${fixtureName}. Available: ${Object.keys(fixtures).join(', ')}`);
  }

  // Create new project and switch to single view
  const createResult = await browser.executeAsync(
    async (
      projectName: string,
      done: (result: { success: boolean; error?: string }) => void
    ) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              createProject: (name: string, location?: string) => Promise<{ success: boolean; error?: string | null }>;
            };
          };
          uiStore: {
            getState: () => {
              setView: (view: string) => void;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) {
        done({ success: false, error: 'E2E helpers not found' });
        return;
      }

      try {
        // Pass /tmp as location since documents directory isn't available under tauri-driver
        const result = await e2e.projectStore.getState().createProject(projectName, '/tmp');
        if (result.success) {
          // Switch to single view so MapCanvas mounts
          e2e.uiStore.getState().setView('single');
        }
        done({ success: result.success, error: result.error ?? undefined });
      } catch (err) {
        done({ success: false, error: String(err) });
      }
    },
    fixture.projectName + '_' + Date.now()
  );

  if (!createResult.success) {
    throw new Error(`Failed to create project: ${createResult.error}`);
  }

  // Wait for SingleSystemView to appear
  await browser.waitUntil(
    async () => {
      const canvas = await $('canvas');
      return await canvas.isExisting();
    },
    {
      timeout: 15000,
      timeoutMsg: 'SingleSystemView did not appear after creating project',
    }
  );

  // Create each section
  for (const section of fixture.sections) {
    const sectionResult = await browser.executeAsync(
      async (
        sectionData: {
          name: string;
          color: string;
          shots: Array<{
            azimuth_in: number;
            azimuth_out: number;
            length: number;
            depth_in: number;
            depth_out: number;
          }>;
        },
        done: (result: { success: boolean; error?: string }) => void
      ) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                createSection: (data: {
                  name: string;
                  color: string;
                  surveyor: string;
                  date: string;
                  shots: Array<{
                    azimuth_in: number;
                    azimuth_out: number;
                    length: number;
                    depth_in: number;
                    depth_out: number;
                  }>;
                }) => Promise<{ success: boolean; error?: string }>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false, error: 'E2E helpers not found' });
          return;
        }

        try {
          const result = await e2e.projectStore.getState().createSection({
            ...sectionData,
            surveyor: 'Test Surveyor',
            date: new Date().toISOString().split('T')[0],
          });
          done(result);
        } catch (err) {
          done({ success: false, error: String(err) });
        }
      },
      section
    );

    if (!sectionResult.success) {
      throw new Error(`Failed to create section ${section.name}: ${sectionResult.error}`);
    }
  }
}

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

  // Wait for GlobalView - give extra time for React to re-render after state change
  await waitForUiIdle(200);

  // Check if React is still mounted (root div has content)
  const isReactMounted = await browser.execute(() => {
    const root = document.getElementById('root');
    return root && root.innerHTML.length > 50;
  });

  if (!isReactMounted) {
    console.log('[resetAppState] React unmounted, refreshing page...');
    await browser.refresh();
    await waitForAppReady();
  }

  const globalView = await $('[data-testid="global-view"]');
  await globalView.waitForExist({ timeout: 10000 });
  await waitForUiIdle(200);
}

/**
 * Wait for the map to be loaded and ready for interaction.
 */
export async function waitForMapReady(): Promise<void> {
  // Longer timeout for parallel execution where resource contention may slow startup
  const mapTimeout = 30000;

  const mapCanvas = await $('[data-testid="map-canvas"]');
  await mapCanvas.waitForExist({ timeout: mapTimeout });

  await browser.waitUntil(
    async () => {
      const attrLoaded = await mapCanvas.getAttribute('data-map-loaded');
      if (attrLoaded === 'true') {
        return true;
      }

      const loaded = await browser.execute(() => {
        const map = (window as unknown as { __stalagmight_map__?: { loaded?: () => boolean } }).__stalagmight_map__;
        return map?.loaded?.() ?? false;
      });

      return loaded;
    },
    {
      timeout: mapTimeout,
      timeoutMsg: `Map did not load within ${mapTimeout / 1000} seconds`,
    }
  );
}

/**
 * Wait for the map to finish moving/animating.
 */
export async function waitForMapIdle(minDelayMs = 0): Promise<void> {
  await waitForMapReady();
  const start = Date.now();

  await browser.waitUntil(
    async () => {
      const mapIdle = await browser.execute(() => {
        const map = (window as unknown as {
          __stalagmight_map__?: {
            loaded?: () => boolean;
            isMoving?: () => boolean;
            isZooming?: () => boolean;
            isRotating?: () => boolean;
            isPitching?: () => boolean;
          };
        }).__stalagmight_map__;

        if (!map) return true;
        const loaded = map.loaded?.() ?? true;
        const moving = map.isMoving?.() ?? false;
        const zooming = map.isZooming?.() ?? false;
        const rotating = map.isRotating?.() ?? false;
        const pitching = map.isPitching?.() ?? false;
        return loaded && !moving && !zooming && !rotating && !pitching;
      });

      if (!mapIdle) {
        return false;
      }

      return Date.now() - start >= minDelayMs;
    },
    {
      timeout: 10000,
      timeoutMsg: 'Map did not reach idle state',
    }
  );
}

/**
 * Wait for the UI to be fully idle (document ready + map idle if present).
 */
export async function waitForUiIdle(minDelayMs = 0): Promise<void> {
  const start = Date.now();

  await browser.waitUntil(
    async () => {
      const docReady = await browser.execute(() => document.readyState === 'complete');
      if (!docReady) return false;

      const viewReady = await browser.execute(() => {
        return !!document.querySelector('[data-testid="global-view"], [data-testid="single-system-view"]');
      });
      if (!viewReady) return false;

      const mapExists = await $('[data-testid="map-canvas"]').isExisting();
      if (mapExists) {
        const mapIdle = await browser.execute(() => {
          const map = (window as unknown as {
            __stalagmight_map__?: {
              loaded?: () => boolean;
              isMoving?: () => boolean;
              isZooming?: () => boolean;
              isRotating?: () => boolean;
              isPitching?: () => boolean;
            };
          }).__stalagmight_map__;

          if (!map) return false;
          const loaded = map.loaded?.() ?? false;
          const moving = map.isMoving?.() ?? false;
          const zooming = map.isZooming?.() ?? false;
          const rotating = map.isRotating?.() ?? false;
          const pitching = map.isPitching?.() ?? false;
          return loaded && !moving && !zooming && !rotating && !pitching;
        });

        if (!mapIdle) {
          return false;
        }
      }

      return Date.now() - start >= minDelayMs;
    },
    {
      timeout: 15000,
      timeoutMsg: 'UI did not reach idle state',
    }
  );
}

/**
 * Wait for a specific map tool to be active.
 */
export async function waitForActiveTool(tool: string): Promise<void> {
  const mapCanvas = await $('[data-testid="map-canvas"]');
  await mapCanvas.waitForExist({ timeout: 15000 });

  await browser.waitUntil(
    async () => {
      const activeTool = await mapCanvas.getAttribute('data-active-tool');
      return activeTool === tool;
    },
    {
      timeout: 5000,
      timeoutMsg: `Active tool did not switch to ${tool}`,
    }
  );
}

/**
 * Wait for a panel to be open/closed via UI store state.
 */
export async function waitForPanelState(
  panel: 'sections' | 'detail' | 'dataTable',
  open: boolean
): Promise<void> {
  await browser.waitUntil(
    async () => {
      const isOpen = await browser.execute((panelName: 'sections' | 'detail' | 'dataTable') => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            uiStore: { getState: () => { sectionsPanelOpen: boolean; detailPanelOpen: boolean; dataTableOpen: boolean } };
          };
        }).__E2E_TEST__;

        if (!e2e) return null;
        const ui = e2e.uiStore.getState();
        if (panelName === 'sections') return ui.sectionsPanelOpen;
        if (panelName === 'detail') return ui.detailPanelOpen;
        return ui.dataTableOpen;
      }, panel);

      return isOpen === open;
    },
    {
      timeout: 5000,
      timeoutMsg: `Panel ${panel} did not ${open ? 'open' : 'close'}`,
    }
  );
}

/**
 * Wait for the application to be fully loaded and ready.
 * Checks for the main app container to be present.
 */
export async function waitForAppReady(): Promise<void> {
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
      const mapCanvas = await $('[data-testid="map-canvas"]');
      return await mapCanvas.isExisting();
    },
    {
      timeout: 30000,
      timeoutMsg: 'Application did not load within 30 seconds',
    }
  );

  // Extra idle check for React to finish rendering
  await waitForUiIdle(200);
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
  const dialog = await $('[data-testid="new-project-dialog"]');
  await dialog.waitForDisplayed({ timeout: 15000 });

  // Fill in the project name - look for the first text input in the dialog
  const nameInput = await dialog.$('[data-testid="new-project-name-input"]');
  await nameInput.waitForEnabled({ timeout: 5000 });
  await nameInput.setValue(projectName);

  // Create project directly via store (bypassing button click which doesn't work in WebdriverIO)
  // Pass /tmp as location since documents directory isn't available under tauri-driver
  // Add timestamp to avoid "file already exists" errors from previous test runs
  const uniqueName = `${projectName}_${Date.now()}`;
  const createResult = await browser.executeAsync(
    async (name: string, done: (result: { success: boolean; error?: string }) => void) => {
      const e2e = (window as { __E2E_TEST__?: {
        projectStore: {
          getState: () => {
            createProject: (name: string, location?: string) => Promise<{ success: boolean; error?: string | null }>
          }
        };
        uiStore: {
          getState: () => {
            closeDialog: () => void
          }
        }
      } }).__E2E_TEST__;

      if (!e2e) {
        done({ success: false, error: 'E2E helpers not available' });
        return;
      }

      try {
        // Pass /tmp as location since documents directory isn't available under tauri-driver
        const result = await e2e.projectStore.getState().createProject(name, '/tmp');
        if (result.success) {
          e2e.uiStore.getState().closeDialog();
        }
        done({ success: result.success, error: result.error ?? undefined });
      } catch (err) {
        done({ success: false, error: String(err) });
      }
    },
    uniqueName
  );
  console.log('[createNewProject] Create result:', createResult);

  if (!createResult.success) {
    throw new Error(`Failed to create project: ${createResult.error}`);
  }

  await browser.waitUntil(
    async () => !(await $('[data-testid="new-project-dialog"]').isExisting()),
    {
      timeout: 10000,
      timeoutMsg: 'New project dialog did not close after create',
    }
  );

  // Wait for SingleSystemView and map to be ready (indicates project was created)
  const singleView = await $('[data-testid="single-system-view"]');
  await singleView.waitForExist({ timeout: 15000 });
  await waitForMapReady();
}

/**
 * Open the DMP Import Dialog (Step 1: DmpSelectionDialog) with a parsed DMP file.
 *
 * With the new two-step import flow:
 * - Step 1: DmpSelectionDialog - Select sections from DMP file
 * - Step 2: DmpSectionConfigDialog - Configure each section
 *
 * This helper parses the DMP file via IPC and opens Step 1 directly.
 * Note: Ctrl+I triggers the native file picker which can't be automated in E2E tests.
 *
 * @param filePath - Path to the DMP file to parse (defaults to test_v5.dmp fixture)
 */
export async function openDmpImportDialog(filePath?: string): Promise<void> {
  // Use default fixture if no path provided
  const resolvedPath = filePath ?? `${process.cwd()}/e2e/fixtures/test_v5.dmp`;

  // Parse DMP file via store (uses IPC internally)
  const parseResult = await browser.executeAsync(
    async (path: string, done: (result: { dmpFile?: unknown; error?: string }) => void) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              importDmp: (path: string) => Promise<unknown>;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) {
        done({ error: 'E2E helpers not available' });
        return;
      }

      try {
        const dmpFile = await e2e.projectStore.getState().importDmp(path);
        done({ dmpFile });
      } catch (err) {
        done({ error: String(err) });
      }
    },
    resolvedPath
  );

  if (parseResult.error) {
    throw new Error(`Failed to parse DMP file: ${parseResult.error}`);
  }

  // Open Step 1 dialog (DmpSelectionDialog) with parsed data
  await browser.execute(
    (dmpFile: unknown, path: string) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          uiStore: {
            getState: () => {
              openDialog: (name: string, data?: unknown) => void;
            };
          };
        };
      }).__E2E_TEST__;

      if (e2e) {
        e2e.uiStore.getState().openDialog('dmp-selection', {
          dmpFile,
          filePath: path,
        });
      }
    },
    parseResult.dmpFile,
    resolvedPath
  );

  // Wait for Step 1 dialog (DmpSelectionDialog) to appear
  const importDialog = await $('[data-testid="dmp-selection-dialog"]');
  await importDialog.waitForDisplayed({
    timeout: 5000,
    timeoutMsg: 'DMP Selection dialog (Step 1) did not appear',
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
  await waitForPanelState('sections', true);
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
 * Press Escape key. This clears tool/selection state in useKeyboardShortcuts
 * and also closes any open dialog.
 */
export async function pressEscape(): Promise<void> {
  await browser.keys(['Escape']);
  // Wait for state to update
  await waitForUiIdle(150);
}

/**
 * Save the current project using keyboard shortcut.
 */
export async function saveProject(): Promise<void> {
  await browser.keys(['Control', 's']);
  // Wait a moment for save to complete
  await waitForUiIdle(500);
}

/**
 * Trigger undo action.
 */
export async function undo(): Promise<void> {
  await browser.keys(['Control', 'z']);
  await waitForUiIdle(200);
}

/**
 * Trigger redo action.
 */
export async function redo(): Promise<void> {
  await browser.keys(['Control', 'y']);
  await waitForUiIdle(200);
}

/**
 * Switch to a specific map tool by keyboard shortcut.
 */
export async function selectTool(
  tool: 'select' | 'pan' | 'zoom' | 'draw' | 'delete' | 'merge' | 'measure' | 'moveStation' | 'moveSegment' | 'moveShot'
): Promise<void> {
  // Keys to send for each tool (arrays for multi-key combos like Shift+key)
  const toolKeys: Record<string, string[]> = {
    select: ['s'],
    pan: ['p'],
    zoom: ['z'],
    draw: ['d'],
    delete: ['x'],
    merge: ['m'],
    measure: ['r'],
    moveStation: ['t'],
    moveSegment: ['v'],
    moveShot: ['g'],
  };

  // Map camelCase helper names to snake_case store names
  const storeToolNames: Record<string, string> = {
    select: 'select',
    pan: 'pan',
    zoom: 'zoom',
    draw: 'draw',
    delete: 'delete',
    merge: 'merge',
    measure: 'measure',
    moveStation: 'move_station',
    moveSegment: 'move_segment',
    moveShot: 'move_shot',
  };

  await browser.keys(toolKeys[tool] ?? ['s']);
  await waitForActiveTool(storeToolNames[tool] ?? tool);
}

function shortcutToKeys(shortcut: string): string[] {
  return shortcut
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      switch (lower) {
        case 'ctrl':
        case 'control':
        case 'cmd':
        case 'command':
        case 'meta':
          return 'Control';
        case 'alt':
        case 'option':
          return 'Alt';
        case 'shift':
          return 'Shift';
        case 'space':
          return ' ';
        case 'escape':
        case 'esc':
          return 'Escape';
        case 'plus':
          return '+';
        case 'minus':
          return '-';
        case 'equal':
        case 'equals':
          return '=';
        default:
          if (part.length === 1 && /[A-Z]/.test(part)) {
            return part.toLowerCase();
          }
          return part;
      }
    });
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

  await browser.execute(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active && typeof active.blur === 'function') {
      active.blur();
    }
    if (!document.body.hasAttribute('tabindex')) {
      document.body.setAttribute('tabindex', '-1');
    }
    document.body.focus();
  });

  const mapCanvas = await $('[data-testid="map-canvas"]');
  if (await mapCanvas.isExisting()) {
    await mapCanvas.click();
  }

  const wasOpen = await browser.execute((panelName: 'sections' | 'detail' | 'dataTable') => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: { uiStore: { getState: () => { sectionsPanelOpen: boolean; detailPanelOpen: boolean; dataTableOpen: boolean } } };
    }).__E2E_TEST__;
    if (!e2e) return null;
    const ui = e2e.uiStore.getState();
    if (panelName === 'sections') return ui.sectionsPanelOpen;
    if (panelName === 'detail') return ui.detailPanelOpen;
    return ui.dataTableOpen;
  }, panel);

  const shortcut = await browser.execute((panelName: 'sections' | 'detail' | 'dataTable') => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        projectStore?: {
          getState: () => { config?: { shortcuts?: Record<string, string[]> } };
        };
      };
    }).__E2E_TEST__;
    const shortcuts = e2e?.projectStore?.getState().config?.shortcuts;
    if (!shortcuts) return null;
    const map: Record<string, string> = {
      sections: 'toggle_sections_panel',
      detail: 'toggle_detail_panel',
      dataTable: 'toggle_data_table',
    };
    const key = map[panelName];
    const bindings = shortcuts[key];
    return Array.isArray(bindings) && bindings.length > 0 ? bindings[0] : null;
  }, panel);

  const keySequence = shortcut ? shortcutToKeys(shortcut) : [panelKeys[panel] ?? '1'];
  await browser.keys(keySequence.length > 0 ? keySequence : [panelKeys[panel] ?? '1']);
  if (wasOpen !== null) {
    await waitForPanelState(panel, !wasOpen);
  } else {
    await waitForUiIdle(200);
  }
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
 * It parses the DMP file and creates all sections in the project.
 * Returns the import result including section count.
 */
export async function importDmpFile(path: string): Promise<{ success: boolean; error?: string; sectionCount?: number }> {
  try {
    return await browser.executeAsync(
    async (
      filePath: string,
      done: (result: { success: boolean; error?: string; sectionCount?: number }) => void
    ) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              importDmp: (path: string) => Promise<{
                sections: Array<{
                  name: string;
                  date?: string;
                  surveyor?: string;
                  shots: Array<{
                    shot_type: string;
                    heading_in: number;
                    heading_out: number;
                    length: number;
                    depth_in: number;
                    depth_out: number;
                    left?: number;
                    right?: number;
                    up?: number;
                    down?: number;
                  }>;
                }>;
              }>;
              createSection: (data: {
                name: string;
                surveyor: string;
                date: string;
                color: string;
                shots: Array<{
                  azimuth_in: number;
                  azimuth_out: number;
                  length: number;
                  depth_in: number;
                  depth_out: number;
                  left?: number;
                  right?: number;
                  up?: number;
                  down?: number;
                }>;
              }) => Promise<{ success: boolean; error?: string }>;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) {
        done({ success: false, error: 'E2E helpers not found' });
        return;
      }

      // Color palette for sections
      const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F'];

      try {
        // Parse the DMP file
        const dmpFile = await e2e.projectStore.getState().importDmp(filePath);
        const sectionCount = dmpFile.sections.length;

        // Create each section in the project
        for (let i = 0; i < dmpFile.sections.length; i++) {
          const section = dmpFile.sections[i];
          // Filter to only standard shots with valid required fields
          // Note: DMP parser uses heading_in/heading_out, createSection expects azimuth_in/azimuth_out
          const standardShots = section.shots
            .filter((s) => s.shot_type === 'Standard')
            .filter((s) =>
              typeof s.heading_in === 'number' &&
              typeof s.heading_out === 'number' &&
              typeof s.length === 'number' &&
              typeof s.depth_in === 'number' &&
              typeof s.depth_out === 'number'
            )
            .map((s) => ({
              azimuth_in: s.heading_in,
              azimuth_out: s.heading_out,
              length: s.length,
              depth_in: s.depth_in,
              depth_out: s.depth_out,
              left: typeof s.left === 'number' ? s.left : undefined,
              right: typeof s.right === 'number' ? s.right : undefined,
              up: typeof s.up === 'number' ? s.up : undefined,
              down: typeof s.down === 'number' ? s.down : undefined,
            }));

          // Parse date - can be NaiveDateTime string like "2024-01-15T10:30:00" or null
          // Backend expects YYYY-MM-DD format
          let dateStr = new Date().toISOString().split('T')[0];
          if (section.date) {
            // Handle NaiveDateTime format from Rust (YYYY-MM-DDTHH:MM:SS or YYYY-MM-DD)
            const dateMatch = String(section.date).match(/^(\d{4}-\d{2}-\d{2})/);
            if (dateMatch) {
              dateStr = dateMatch[1];
            }
          }

          const sectionData = {
            name: section.name || `Section ${i + 1}`,
            surveyor: section.surveyor || 'Unknown',
            date: dateStr,
            color: colors[i % colors.length],
            shots: standardShots,
          };

          const result = await e2e.projectStore.getState().createSection(sectionData);
          if (!result.success) {
            done({ success: false, error: result.error ?? `Failed to create section ${section.name}`, sectionCount: i });
            return;
          }
        }

        done({ success: true, sectionCount });
      } catch (err) {
        done({ success: false, error: String(err) });
      }
    },
    path
  );
  } catch (err) {
    // WebDriverError is thrown when the inner code throws before calling done()
    // Extract the error message from the WebDriverError
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMessage };
  }
}

/**
 * Open DMP import dialog (Step 1: DmpSelectionDialog) with a specific DMP file.
 *
 * This helper:
 * 1. Parses the DMP file via IPC (import_dmp command)
 * 2. Opens Step 1 dialog (DmpSelectionDialog) with the parsed data
 *
 * Note: The native file picker (Ctrl+I) can't be automated, so we bypass it by
 * parsing the file directly and opening the dialog with the data.
 *
 * @param filePath - Absolute path to the DMP file to import
 */
export async function openDmpImportWithFile(filePath: string): Promise<void> {
  // Close any existing dialog first to ensure clean state
  await browser.execute(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: {
          getState: () => {
            closeDialog: () => void;
          };
        };
      };
    }).__E2E_TEST__;
    if (e2e) {
      e2e.uiStore.getState().closeDialog();
    }
  });
  await waitForUiIdle(100);

  // Parse DMP file via store (uses IPC internally)
  const parseResult = await browser.executeAsync(
    async (path: string, done: (result: { dmpFile?: unknown; error?: string }) => void) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              importDmp: (path: string) => Promise<unknown>;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) {
        done({ error: 'E2E helpers not available' });
        return;
      }

      try {
        const dmpFile = await e2e.projectStore.getState().importDmp(path);
        done({ dmpFile });
      } catch (err) {
        done({ error: String(err) });
      }
    },
    filePath
  );

  if (parseResult.error) {
    throw new Error(`Failed to parse DMP file: ${parseResult.error}`);
  }

  // Open Step 1 dialog (DmpSelectionDialog) with parsed data
  await browser.execute(
    (dmpFile: unknown, path: string) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          uiStore: {
            getState: () => {
              openDialog: (name: string, data?: unknown) => void;
            };
          };
        };
      }).__E2E_TEST__;

      if (e2e) {
        e2e.uiStore.getState().openDialog('dmp-selection', {
          dmpFile,
          filePath: path,
        });
      }
    },
    parseResult.dmpFile,
    filePath
  );

  // Wait for Step 1 dialog (DmpSelectionDialog) to open
  const importDialog = await $('[data-testid="dmp-selection-dialog"]');
  await importDialog.waitForDisplayed({ timeout: 5000 });

  // Wait for dialog to be fully rendered by checking for section content
  await browser.waitUntil(
    async () => {
      const dialogText = await importDialog.getText();
      // Check for version text which indicates successful parse
      if (dialogText.toLowerCase().includes('version')) {
        return true;
      }
      // Check for section rows which indicate the dialog is populated
      const sectionRow = await importDialog.$('[data-testid="section-row-0"]');
      return await sectionRow.isExisting();
    },
    {
      timeout: 10000,
      timeoutMsg: 'DMP Selection dialog did not fully load',
      interval: 500,
    }
  );

  // Extra pause for React to finish rendering
  await waitForUiIdle(200);
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

// ============================================================================
// Fractal Test Helpers
// ============================================================================

/**
 * Create a section with shots via the store.
 * Returns the actual backend section ID for tracking.
 *
 * @param data - Section data including name, color, and shots
 * @returns Result with success status and backend section ID
 */
export async function createSectionViaStore(data: {
  name: string;
  color: string;
  shots: Array<{
    azimuth_in: number;
    azimuth_out: number;
    length: number;
    depth_in: number;
    depth_out: number;
  }>;
}): Promise<{ success: boolean; sectionId?: number; error?: string }> {
  return await browser.executeAsync(
    async (
      sectionData: {
        name: string;
        color: string;
        shots: Array<{
          azimuth_in: number;
          azimuth_out: number;
          length: number;
          depth_in: number;
          depth_out: number;
        }>;
      },
      done: (result: { success: boolean; sectionId?: number; error?: string }) => void
    ) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              createSection: (data: {
                name: string;
                color: string;
                surveyor: string;
                date: string;
                shots: Array<{
                  azimuth_in: number;
                  azimuth_out: number;
                  length: number;
                  depth_in: number;
                  depth_out: number;
                }>;
              }) => Promise<{ success: boolean; section_id?: number; error?: string }>;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) {
        done({ success: false, error: 'E2E helpers not found' });
        return;
      }

      try {
        const result = await e2e.projectStore.getState().createSection({
          ...sectionData,
          surveyor: 'Fractal Generator',
          date: new Date().toISOString().split('T')[0],
        });
        done({
          success: result.success,
          sectionId: result.section_id,
          error: result.error ?? undefined,
        });
      } catch (err) {
        done({ success: false, error: String(err) });
      }
    },
    data
  );
}

/**
 * Merge two stations via the store.
 *
 * @param stationA - First station reference
 * @param stationB - Second station reference
 * @returns Result with success status
 */
export async function mergeStationsViaStore(
  stationA: { section_id: number; station_index: number },
  stationB: { section_id: number; station_index: number },
): Promise<{ success: boolean; error?: string }> {
  return await browser.executeAsync(
    async (
      a: { section_id: number; station_index: number },
      b: { section_id: number; station_index: number },
      done: (result: { success: boolean; error?: string }) => void
    ) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              mergeStations: (
                stationA: { section_id: number; station_index: number },
                stationB: { section_id: number; station_index: number },
              ) => Promise<{ success: boolean; error?: string }>;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) {
        done({ success: false, error: 'E2E helpers not found' });
        return;
      }

      try {
        const result = await e2e.projectStore.getState().mergeStations(a, b);
        done({
          success: result.success,
          error: result.error ?? undefined,
        });
      } catch (err) {
        done({ success: false, error: String(err) });
      }
    },
    stationA,
    stationB,
  );
}

/**
 * Save the current project to a specific file path via the store.
 *
 * @param filePath - Absolute path to save the project file
 * @returns Result with success status
 */
export async function saveProjectToPath(
  filePath: string
): Promise<{ success: boolean; error?: string }> {
  return await browser.executeAsync(
    async (
      path: string,
      done: (result: { success: boolean; error?: string }) => void
    ) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              saveProject: (path: string) => Promise<{ success: boolean; error?: string }>;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) {
        done({ success: false, error: 'E2E helpers not found' });
        return;
      }

      try {
        const result = await e2e.projectStore.getState().saveProject(path);
        done({
          success: result.success,
          error: result.error ?? undefined,
        });
      } catch (err) {
        done({ success: false, error: String(err) });
      }
    },
    filePath
  );
}

/**
 * Get the station merges from the current project.
 * Used for verifying merge relationships after fractal generation.
 *
 * @returns Array of station merge objects
 */
export async function getProjectMerges(): Promise<
  Array<{
    station_a: { section_id: number; station_index: number };
    station_b: { section_id: number; station_index: number };
  }>
> {
  return await browser.executeAsync(
    (
      done: (
        merges: Array<{
          station_a: { section_id: number; station_index: number };
          station_b: { section_id: number; station_index: number };
        }>
      ) => void
    ) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              project: {
                station_merges: Array<{
                  station_a: { section_id: number; station_index: number };
                  station_b: { section_id: number; station_index: number };
                }>;
              } | null;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e || !e2e.projectStore.getState().project) {
        done([]);
        return;
      }

      done(e2e.projectStore.getState().project?.station_merges ?? []);
    }
  );
}

// ============================================================================
// TML Import/Export Helpers
// ============================================================================

/**
 * Parse a TML/TMLU file via the store (uses IPC internally).
 * Returns the parsed TmlFile data.
 *
 * @param filePath - Absolute path to the TML/TMLU file
 */
export async function parseTmlFile(filePath: string): Promise<{ tmlFile?: unknown; error?: string }> {
  return await browser.executeAsync(
    async (path: string, done: (result: { tmlFile?: unknown; error?: string }) => void) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              parseTml: (path: string) => Promise<unknown>;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) {
        done({ error: 'E2E helpers not available' });
        return;
      }

      try {
        const tmlFile = await e2e.projectStore.getState().parseTml(path);
        done({ tmlFile });
      } catch (err) {
        done({ error: String(err) });
      }
    },
    filePath
  );
}

/**
 * Open the TML Import Dialog with a parsed TML file.
 * Parses the file via IPC, then opens the tml-import dialog with the data.
 *
 * @param filePath - Absolute path to the TML/TMLU file
 */
export async function openTmlImportWithFile(filePath: string): Promise<void> {
  // Close any existing dialog first
  await browser.execute(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: {
          getState: () => {
            closeDialog: () => void;
          };
        };
      };
    }).__E2E_TEST__;
    if (e2e) {
      e2e.uiStore.getState().closeDialog();
    }
  });
  await waitForUiIdle(100);

  // Parse TML file
  const parseResult = await parseTmlFile(filePath);
  if (parseResult.error) {
    throw new Error(`Failed to parse TML file: ${parseResult.error}`);
  }

  // Open tml-import dialog with parsed data
  await browser.execute(
    (tmlFile: unknown, path: string) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          uiStore: {
            getState: () => {
              openDialog: (name: string, data?: unknown) => void;
            };
          };
        };
      }).__E2E_TEST__;

      if (e2e) {
        e2e.uiStore.getState().openDialog('tml-import', {
          tmlFile,
          filePath: path,
        });
      }
    },
    parseResult.tmlFile,
    filePath
  );

  // Wait for TML import dialog to appear
  const importDialog = await $('[data-testid="tml-import-dialog"]');
  await importDialog.waitForDisplayed({
    timeout: 10000,
    timeoutMsg: 'TML Import dialog did not appear',
  });

  await waitForUiIdle(200);
}

/**
 * Import a TML/TMLU file directly via the store's executeTmlImport.
 * This bypasses the UI dialog for quick programmatic import.
 *
 * @param filePath - Absolute path to the TML/TMLU file
 * @param includeExcluded - Whether to include excluded shots (default: false)
 */
export async function importTmlFile(
  filePath: string,
  includeExcluded = false
): Promise<{ success: boolean; error?: string }> {
  try {
    return await browser.executeAsync(
      async (
        path: string,
        inclExcl: boolean,
        done: (result: { success: boolean; error?: string }) => void
      ) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                calculateFileHash: (path: string) => Promise<string>;
                executeTmlImport: (path: string, fileHash?: string | null, includeExcluded?: boolean) => Promise<{ success: boolean; error?: string | null }>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false, error: 'E2E helpers not found' });
          return;
        }

        try {
          const hash = await e2e.projectStore.getState().calculateFileHash(path);
          const result = await e2e.projectStore.getState().executeTmlImport(path, hash, inclExcl);
          done({ success: result.success, error: result.error ?? undefined });
        } catch (err) {
          done({ success: false, error: String(err) });
        }
      },
      filePath,
      includeExcluded
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMessage };
  }
}

/**
 * Export the current project as TML format.
 *
 * @param filePath - Absolute path for the output TML file
 */
export async function exportTmlFile(
  filePath: string
): Promise<{ success: boolean; error?: string }> {
  return await browser.executeAsync(
    async (
      path: string,
      done: (result: { success: boolean; error?: string }) => void
    ) => {
      const e2e = (window as unknown as {
        __E2E_TEST__?: {
          projectStore: {
            getState: () => {
              exportTml: (path: string) => Promise<void>;
            };
          };
        };
      }).__E2E_TEST__;

      if (!e2e) {
        done({ success: false, error: 'E2E helpers not found' });
        return;
      }

      try {
        await e2e.projectStore.getState().exportTml(path);
        done({ success: true });
      } catch (err) {
        done({ success: false, error: String(err) });
      }
    },
    filePath
  );
}
