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
 * - `.wpj` / `.srv`     -> Walls import (always a new project)
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
import { useSpeleoStore, selectSpeleoReadOnly } from '../store/speleoStore';
import { isEditingBlockedNow } from '../hooks/useEditingBlocked';
import { getErrorMessage } from './ipc';
import { extractFilename } from './path';
import { openOrImportFilters, IMPORTABLE_EXTENSIONS } from './fileDialogs';
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
  // Recognized importable survey formats (everything routed below except .stalx).
  // Derived from the single source of truth in fileDialogs so this guard and the
  // file-dialog filters can't drift. Used to scope the read-only guard so an
  // UNSUPPORTED file still gets the "Unsupported file type" error rather than the
  // misleading "switch view" one. IMPORTABLE_EXTENSIONS has no leading dots, so
  // prefix one to keep the original `.gpx`/`.dmp` endsWith semantics.
  const isImportable = IMPORTABLE_EXTENSIONS.some((ext) => lowerPath.endsWith(`.${ext}`));

  // A dialog (or the terminal command it triggers) now owns the pending entry-
  // point source's lifetime — leave it set so that flow can apply it on
  // completion (or drop it on cancel via checkDialogCancel). EVERY other path
  // (abandon, guard-rejected, parse-null, unsupported, error) drops the source
  // in the finally below, so it can't mis-attribute a later, unrelated project
  // command. `setView('single')` clears it on a successful open/create.
  let handedOff = false;

  try {
    // Importing into an open project adds sections (a mutation). The read-only map
    // (#70 closure-adjusted view, #243 Plan/Export, or a locked remote SpeleoDB
    // project) rejects an import while active. Centralized here so every caller
    // (toolbar, Ctrl+I, drag-drop) shares it. Scoped to recognized importable
    // files so an unsupported/unknown extension still falls through to the
    // accurate "Unsupported file type" error below (opening a native .stalx
    // project is not an import, so it's exempt too).
    if (isImportable && hasProject && isEditingBlockedNow()) {
      // Tailor the fix-it advice to the active read-only cause(s) - read the
      // individual flags separately (not via isMapReadOnly/isEditingBlockedNow,
      // which only report the combined boolean) so a compound state (e.g. a
      // locked remote project also viewed in Plan mode) mentions BOTH causes
      // instead of silently dropping the SpeleoDB lock from the message.
      const speleoReadOnly = selectSpeleoReadOnly(useSpeleoStore.getState());
      const nonSurveyMode = ui.appMode !== 'survey';
      const closureAdjusted = ui.geometryMode === 'closureAdjusted';
      let message: string;
      if (speleoReadOnly && nonSurveyMode) {
        message = 'Switch to Survey mode and acquire the SpeleoDB write lock to import.';
      } else if (speleoReadOnly && closureAdjusted) {
        message = 'Switch to the Measured view and acquire the SpeleoDB write lock to import.';
      } else if (speleoReadOnly) {
        message = 'Acquire the SpeleoDB write lock to import.';
      } else if (nonSurveyMode) {
        message = 'Switch to Survey mode to import - the Plan and Export workspaces are read-only.';
      } else {
        message = 'Switch to the Measured view to import - the closure-adjusted view is read-only.';
      }
      ui.openDialog('error', { title: 'Import', message });
      return;
    }

    if (lowerPath.endsWith('.stalx')) {
      // Native project: guard against silently discarding unsaved edits. Opening
      // a .stalx replaces the current project, so if one is open and dirty, defer
      // to the unsaved-changes dialog (it loads on discard) instead of clobbering
      // it. Centralized here so EVERY .stalx-open path (Ctrl+O, drag-drop, the
      // unified Open/Import button) shares the guard, not just the menu item.
      if (store.project && store.isDirty) {
        ui.openDialog('unsaved-changes', { pendingOpenPath: path });
        handedOff = true;
      } else {
        // loadProject handles view switching and error display, and consumes the
        // source itself (setView on success / its error paths on failure).
        await store.loadProject(path);
      }
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
      handedOff = true;
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
      handedOff = true;
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
      handedOff = true;
    } else if (lowerPath.endsWith('.wpj') || lowerPath.endsWith('.srv')) {
      // Walls import always creates a new project.
      if (store.project) {
        ui.openDialog('error', IMPORT_SURVEY_CLOSE_FIRST);
        return;
      }
      const wallsFile = await store.parseWalls(path);
      if (!wallsFile) return;
      ui.openDialog('new-project-for-import', {
        wallsFile,
        filePath: path,
        // Prefer the .wpj project name; fall back to the file stem.
        defaultName:
          wallsFile.project_name || extractFilename(path, /\.(wpj|srv)$/i) || 'Imported',
        importType: 'walls',
      });
      handedOff = true;
    } else if (lowerPath.endsWith('.dmp')) {
      // mNemo DMP: import into the current project, or seed a new one.
      const dmpFile = await store.importDmp(path);
      if (!dmpFile) return;
      // Re-read project state fresh after the parse — the existing/new-project
      // decision must reflect the project as it is NOW, not the snapshot taken
      // before the await (a switch could have landed during the parse).
      if (useProjectStore.getState().project) {
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
      handedOff = true;
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
  } finally {
    if (!handedOff) clearProjectActionSource();
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
  let selected: string | string[] | null;
  try {
    selected = await open({ multiple: false, filters });
  } catch (err) {
    // The native picker itself failed (plugin/permission error) — `open()`
    // rejects rather than resolving null. Surface it and drop the entry-point
    // source so it can't attribute a later, unrelated open/create/import (the
    // source has no auto-reset; only a completed flow or this clear drops it).
    clearProjectActionSource();
    useUIStore.getState().openDialog('error', {
      title: errorTitle,
      message: getErrorMessage(err, 'Failed to open the file picker'),
    });
    return;
  }

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
