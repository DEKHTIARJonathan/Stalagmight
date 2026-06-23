/**
 * Unified "Open / Import" routing.
 *
 * A single entry point that accepts any file the app can open or import and
 * dispatches to the right flow based on the file extension:
 *
 * - `.stalx`            -> open the native project (loadProject)
 * - `.gpx`              -> GPX import (new project only; rejected if one is open)
 * - `.tml` / `.tmlu`    -> Ariane import (always a new project)
 * - `.mak` / `.dat`     -> Compass import (always a new project)
 * - `.dmp`              -> DMP import (add to current project, or new project)
 * - anything else       -> unsupported-file error (NOT silently treated as DMP)
 *
 * Importing into an open project while the read-only closure-adjusted view is
 * active is rejected here, so every import entry point shares that guard.
 *
 * The routing is intentionally shared between the toolbar "Open / Import"
 * button, the "open it from file" hint link, and the Ctrl+I keyboard shortcut
 * so all three behave identically. Stores are read via `getState()` so this is
 * callable outside React (e.g. from a raw keydown handler).
 */
import { open } from '@tauri-apps/plugin-dialog';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import { getErrorMessage } from './ipc';
import { extractFilename } from './path';
import { openOrImportFilters } from './fileDialogs';
import { clearProjectActionSource } from './telemetry';

/**
 * Error shown when a new-project-only import (GPX / Ariane / Compass) is
 * attempted while a project is already open. The single source of truth shared
 * by the open/import router and the useProject import handlers.
 */
export const IMPORT_SURVEY_CLOSE_FIRST = {
  title: 'Import survey',
  message: 'Close the current project before importing a new survey.',
} as const;

/**
 * Dispatch an already-chosen path to the matching open/import flow.
 *
 * @param path       Absolute path to the selected file.
 * @param errorTitle Title for the error dialog if the flow throws.
 */
export async function routeOpenedFile(path: string, errorTitle = 'Open Failed'): Promise<void> {
  const lowerPath = path.toLowerCase();
  const store = useProjectStore.getState();
  const ui = useUIStore.getState();
  const hasProject = !!store.project;
  const isProjectFile = lowerPath.endsWith('.stalx');

  // Importing into an open project adds sections (a mutation). The closure-
  // adjusted view (#70) is read-only, so reject an import while it's active.
  // Centralized here so every caller (toolbar, Ctrl+I, drag-drop) shares it.
  // Opening a native project (.stalx) is not an import, so it's exempt.
  if (!isProjectFile && hasProject && ui.geometryMode === 'closureAdjusted') {
    ui.openDialog('error', {
      title: 'Import',
      message: 'Switch to the Measured view to import — the closure-adjusted view is read-only.',
    });
    return;
  }

  try {
    if (lowerPath.endsWith('.stalx')) {
      // Native project: loadProject handles view switching and error display.
      await store.loadProject(path);
    } else if (lowerPath.endsWith('.gpx')) {
      // GPX import creates a new project; importing into an open one isn't
      // supported (DMP is the additive in-project import). Mirror the TML/Compass
      // guard so a GPX opened/dropped while a project is open is rejected, not
      // silently added to the current project.
      if (store.project) {
        ui.openDialog('error', IMPORT_SURVEY_CLOSE_FIRST);
        return;
      }
      const gpxFile = await store.parseGpx(path);
      if (!gpxFile) return;
      ui.openDialog('new-project-for-import', {
        gpxFile,
        filePath: path,
        defaultName: extractFilename(path, /\.gpx$/i) || 'Imported',
        importType: 'gpx',
      });
    } else if (lowerPath.endsWith('.tml') || lowerPath.endsWith('.tmlu')) {
      // TML/TMLU import always creates a new project.
      if (store.project) {
        ui.openDialog('error', IMPORT_SURVEY_CLOSE_FIRST);
        return;
      }
      const tmlFile = await store.parseTml(path);
      if (!tmlFile) return;
      ui.openDialog('new-project-for-import', {
        tmlFile,
        filePath: path,
        defaultName: extractFilename(path, /\.tmlu?$/i) || 'Imported',
        importType: 'tml',
      });
    } else if (lowerPath.endsWith('.mak') || lowerPath.endsWith('.dat')) {
      // Compass import always creates a new project.
      if (store.project) {
        ui.openDialog('error', IMPORT_SURVEY_CLOSE_FIRST);
        return;
      }
      const compassFile = await store.parseCompass(path);
      if (!compassFile) return;
      ui.openDialog('new-project-for-import', {
        compassFile,
        filePath: path,
        defaultName: extractFilename(path, /\.(mak|dat)$/i) || 'Imported',
        importType: 'compass',
      });
    } else if (lowerPath.endsWith('.dmp')) {
      // mNemo DMP: import into the current project, or seed a new one.
      const dmpFile = await store.importDmp(path);
      if (!dmpFile) return;
      if (store.project) {
        ui.setImportContext('existing-project');
        ui.openDialog('dmp-selection', { dmpFile, filePath: path });
      } else {
        ui.setImportContext('new-project');
        ui.openDialog('new-project-for-import', {
          dmpFile,
          filePath: path,
          defaultName: extractFilename(path, /\.dmp$/i) || 'Imported',
        });
      }
    } else {
      // Unknown/unsupported extension — don't blindly assume DMP (that fed
      // arbitrary files chosen via an "All Files" filter to the DMP parser).
      ui.openDialog('error', {
        title: errorTitle,
        message: `Unsupported file type: ${extractFilename(path) || path}`,
      });
    }
  } catch (err) {
    useUIStore.getState().openDialog('error', {
      title: errorTitle,
      message: getErrorMessage(err, 'Failed to open file'),
    });
  }
}

/**
 * Open a single-file picker with the given filters, then route the chosen file
 * to the matching open/import flow. On cancel, drop the entry-point source so it
 * can't attribute a later, unrelated open/create/import. Callers set the source
 * before calling.
 *
 * Shared by the toolbar "Open / Import" button, the in-project import button,
 * and the Ctrl+I keyboard shortcut (GlobalView + in-project), which differ only
 * in the picker filters and the error-dialog title.
 */
export async function pickAndRoute(
  filters: Array<{ name: string; extensions: string[] }>,
  errorTitle = 'Open Failed',
): Promise<void> {
  const selected = await open({ multiple: false, filters });

  let path: string | null = null;
  if (typeof selected === 'string') {
    path = selected;
  } else if (Array.isArray(selected) && (selected as string[]).length > 0) {
    path = (selected as string[])[0] ?? null;
  }

  if (path) {
    await routeOpenedFile(path, errorTitle);
  } else {
    clearProjectActionSource();
  }
}

/**
 * Open the unified picker (native projects + all importable formats), then
 * route the chosen file to the matching flow.
 */
export async function openOrImport(): Promise<void> {
  await pickAndRoute(openOrImportFilters());
}
