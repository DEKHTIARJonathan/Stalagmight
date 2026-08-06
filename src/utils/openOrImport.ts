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
 * Importing INTO an open project while editing is blocked (the closure-adjusted
 * view, the Plan/Export workspaces, or a SpeleoDB project held without the
 * write lock) is rejected here, so every import entry point shares that guard.
 * This only applies to `.dmp` (the sole additive in-project import, #391) - the
 * other formats always close the current project first (via handleCloseProject,
 * which carries its own SpeleoDB hand-back and unsaved-changes guards) rather
 * than mutating it, so the read-only guard doesn't apply to them.
 *
 * ONE DOOR (#407): every open/import entry point - the toolbar "Open / Import"
 * button, the hamburger Open and Import rows in both views, the EmptyState
 * card, the "open it from file" hint link, Ctrl+O, Ctrl+I, and drag-drop -
 * offers the same unified picker (`openOrImportFilters`) and routes the chosen
 * file through here, so "Open" and "Import" are two words for one behavior.
 * Stores are read via `getState()` so this is callable outside React (e.g.
 * from a raw keydown handler).
 */
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import { useSpeleoStore, selectSpeleoReadOnly } from '../store/speleoStore';
import { isEditingBlockedNow } from '../hooks/useEditingBlocked';
import { getErrorMessage } from './ipc';
import { extractFilename } from './path';
import { openDialog, openOrImportFilters, DMP_EXTENSION } from './fileDialogs';
import { clearProjectActionSource } from './telemetry';
import { needsSpeleoHandBackPrompt } from './quit';
import { TOAST_KEYS } from './toastKeys';
import i18n from '../i18n';

/**
 * Open the "import as new project?" confirm dialog (#391) for a new-project-only
 * format (GPX / Ariane / Compass / Walls) picked while a project is already
 * open. Replaces the old close-first dead end (`IMPORT_SURVEY_CLOSE_FIRST`):
 * confirming closes the current project (honoring its own unsaved-changes
 * guard) and then re-routes the same path, which - with no project open - falls
 * through to the normal new-project import chain.
 */
function openImportAsNewProject(ui: ReturnType<typeof useUIStore.getState>, path: string): void {
  ui.openDialog('import-as-new-project', { path, fileName: extractFilename(path) });
}

/**
 * The dialogs that own an IN-FLIGHT import flow - one that has declared an
 * `importContext` and has not yet reached its `saveAfterImport`. Mirrors the
 * import-flow dialogs mounted in App.tsx, in flow order.
 *
 * Three import-adjacent dialogs are deliberately NOT here:
 * - `import-receipt` is post-save (the flow's `saveAfterImport` already ran), so
 *   re-routing behind it can lose nothing, and "finish the current import" would
 *   be false advice for a dialog whose only action is Close.
 * - `import-blocked` and `import-as-new-project` are PRE-flow prompts that own no
 *   context and re-enter this router themselves; both `closeDialog()` first, so
 *   they would pass the guard anyway, but listing them would be a trap.
 */
const IMPORT_FLOW_DIALOGS = new Set([
  'new-project-for-import',
  'dmp-selection',
  'zero-datum-selection',
  'zero-datum-config',
  'dmp-import-new',
  'tml-import',
  'compass-import',
  'walls-import',
  'gpx-selection',
  'gpx-placement',
  'orphan-placement',
]);

/**
 * True while an import flow owns the screen and still needs its `importContext`.
 *
 * Two shapes, because the flow is not always behind a dialog. The DMP wizard's
 * MANUAL PLACEMENT phase hands the map to the user: it calls
 * `startPlacementMode(...)` and then `closeDialog()` (DmpNewImportDialog.tsx,
 * `startSegmentPlacement` -> "Close dialog so user can interact with the map"),
 * so `activeDialog` is null for the whole phase while the flow is very much
 * in-flight and its `saveAfterImport` is still to come. `placementMode` is the
 * signal that covers it: `startPlacementMode` sets it (uiStore) and BOTH exits
 * clear it - `confirmPlacement()` and `cancelPlacementMode()` each
 * `set({ placementMode: null })` - so it is false again the moment placement
 * ends, whether the user placed the segment or cancelled back to the wizard.
 *
 * It reads slightly wider than "import": the paste-sections dialog uses
 * placement too. That is the right side to err on - the rest of the app already
 * treats placement as modal-equivalent (the toolbar disables, SingleSystemView
 * dims and drops pointer events, useKeyboardShortcuts allowlists a handful of
 * actions), so routing a dropped file into it was never wanted either.
 */
function importFlowOwnsScreen(ui: ReturnType<typeof useUIStore.getState>): boolean {
  if (ui.activeDialog && IMPORT_FLOW_DIALOGS.has(ui.activeDialog)) return true;
  return ui.placementMode !== null;
}

/**
 * Dispatch an already-chosen path to the matching open/import flow.
 *
 * @param path       Absolute path to the selected file.
 * @param errorTitle Title for the error dialog if the flow throws.
 * @param opts.residualReadOnlyToast  Set by ImportBlockedDialog's "Switch to
 *   Survey" re-route: the user just confirmed intent there, so a read-only
 *   cause that REMAINS after the switch (e.g. the restored survey view being
 *   closure-adjusted) is reported as a non-blocking toast instead of a second
 *   modal - informational, no click owed. Never set on first-touch routes,
 *   where the modal (or the import-blocked choice) is the right interruption.
 * @param opts.swapConfirmed  Set by LaunchOpenConfirmDialog's "Open" button
 *   when it re-routes the same path after the user confirmed swapping out a
 *   clean, already-open project: skips that same confirm on this second pass,
 *   so confirming doesn't ask again.
 */
export async function routeOpenedFile(
  path: string,
  errorTitle = 'Open Failed',
  opts?: { residualReadOnlyToast?: boolean; swapConfirmed?: boolean },
): Promise<void> {
  const lowerPath = path.toLowerCase();
  const store = useProjectStore.getState();
  const ui = useUIStore.getState();
  const hasProject = !!store.project;

  // A dialog (or the terminal command it triggers) now owns the pending entry-
  // point source's lifetime - leave it set so that flow can apply it on
  // completion (or drop it on cancel via checkDialogCancel). EVERY other path
  // (abandon, guard-rejected, parse-null, unsupported, error) drops the source
  // in the finally below, so it can't mis-attribute a later, unrelated project
  // command. `setView('single')` clears it on a successful open/create.
  let handedOff = false;

  try {
    // One import at a time (#411). Drag-drop routes unconditionally - the drop
    // listener has no modal check (Ctrl+O/Ctrl+I do: useKeyboardShortcuts returns
    // early for every non-Escape key while a dialog is open) - so a second file
    // dropped mid-flow would re-enter here and the reset below would null the
    // context the in-flight flow's `saveAfterImport` is about to read, losing its
    // save. Refuse instead, and say so; the running flow keeps the screen and its
    // context. Guarded in the router, not in the drop handler, so every present
    // and future entry point inherits it. Inside the `try` so the abandoned
    // route's telemetry source is dropped by the `finally`, like every other
    // guard-rejected path.
    if (importFlowOwnsScreen(ui)) {
      ui.showToast(i18n.t('importGate.inProgress'), TOAST_KEYS.IMPORT_IN_PROGRESS, 'warning');
      return;
    }

    // `importContext` tells `saveAfterImport` whether the completion handlers must
    // write the .stalx (a brand-new project's initial save is deferred) or only mark
    // dirty. It has no auto-reset, so a value left behind by a previous flow -
    // abandoned parse, cancelled dialog, or a completed import - would decide the
    // NEXT one, making the save non-deterministic across a session (#411). Reset it
    // here: this router is the single entry point of every import flow, and each
    // branch below re-declares its own context once it commits to a flow.
    ui.setImportContext(null);

    // Importing into an open project adds sections (a mutation) - but only DMP
    // does that; every other importable format instead CLOSES the current
    // project and imports as a new one (openImportAsNewProject below), which
    // doesn't mutate it and carries its own guards via handleCloseProject. So
    // this read-only guard is scoped to `.dmp` only, not every importable
    // extension - the read-only map (#70 closure-adjusted view, #243
    // Plan/Export, or a locked remote SpeleoDB project) rejects only the
    // additive DMP-into-open-project path. Centralized here so every caller
    // (toolbar, Ctrl+I, drag-drop) shares it.
    const isDmp = lowerPath.endsWith(`.${DMP_EXTENSION}`);
    if (isDmp && hasProject && isEditingBlockedNow()) {
      // Tailor the fix-it advice to the active read-only cause(s) - read the
      // individual flags separately (isEditingBlockedNow() reports only the
      // combined boolean, and isMapReadOnly folds the closure-adjusted and
      // Plan/Export causes into one) so a compound state (e.g. a
      // locked remote project also viewed in Plan mode) mentions BOTH causes
      // instead of silently dropping the SpeleoDB lock from the message.
      const speleoReadOnly = selectSpeleoReadOnly(useSpeleoStore.getState());
      const nonSurveyMode = ui.appMode !== 'survey';
      const closureAdjusted = ui.geometryMode === 'closureAdjusted';
      if (!speleoReadOnly) {
        // Every non-SpeleoDB cause is one safe click from fixed, so it's a
        // choice, not an error: the import-blocked prompt offers the switch
        // (Survey mode and/or the Measured view) and CONTINUES this import,
        // or abandons it. `cause` picks the wording; mode wins when both
        // apply because its switch also drops the view. The dialog owns the
        // pending telemetry source from here (complete-on-switch /
        // cancel-on-stay).
        ui.openDialog('import-blocked', { path, cause: nonSurveyMode ? 'mode' : 'view' });
        handedOff = true;
        return;
      }
      // A missing SpeleoDB write lock is the one cause no local switch can
      // fix, so it keeps the plain error dialog (compound states included -
      // switching mode/view alone would still leave the import blocked).
      let message: string;
      if (nonSurveyMode) {
        message = 'Switch to Survey mode and acquire the SpeleoDB write lock to import.';
      } else if (closureAdjusted) {
        message = 'Switch to the Measured view and acquire the SpeleoDB write lock to import.';
      } else {
        message = 'Acquire the SpeleoDB write lock to import.';
      }
      if (opts?.residualReadOnlyToast) {
        // The user just confirmed a switch on the import-blocked prompt -
        // don't demand a second click for a cause the switch could not fix;
        // inform and get out of the way.
        ui.showToast(message, 'import-read-only-residual', 'warning');
      } else {
        ui.openDialog('error', { title: 'Import', message });
      }
      return;
    }

    if (lowerPath.endsWith('.stalx')) {
      // Native project: guard against silently discarding unsaved edits. Opening
      // a .stalx replaces the current project, so if one is open and dirty, defer
      // to the unsaved-changes dialog (it loads on discard) instead of clobbering
      // it. Centralized here so EVERY .stalx-open path (Ctrl+O, drag-drop, the
      // unified Open/Import button) shares the guard, not just the menu item.
      //
      // #270: this is one of the four ways to leave an open project, and it used to
      // gate on the DISK-dirty bit alone - so a remote project saved to disk with a
      // held lock or with edits SpeleoDB has never seen was swapped out with no
      // notice, while closing the same project prompted. Ordered SpeleoDB-first for
      // the same reason `guardQuit` is: the SpeleoDB prompt carries its own "save
      // changes locally" checkbox and so subsumes the disk one, while the reverse
      // order would let "Discard Changes" walk straight past the lock and the
      // unpushed edits. The prompt carries the chosen path and performs the open
      // itself once the SpeleoDB side is resolved, so the user's Ctrl+O is not
      // silently swallowed by the prompt it raised.
      if (store.project && needsSpeleoHandBackPrompt(useSpeleoStore.getState().link)) {
        ui.openDialog('speleodb-close', { pendingOpenPath: path });
        handedOff = true;
      } else if (store.project && store.isDirty) {
        ui.openDialog('unsaved-changes', { pendingOpenPath: path });
        handedOff = true;
      } else if (store.project && !opts?.swapConfirmed) {
        // A clean, locally-owned project is open - dirty and SpeleoDB already
        // prompt above, but a clean project used to fall straight through to
        // loadProject and get swapped out with no notice at all. Reuses the
        // confirm this branch already raises for a `.stalx` the OS FORWARDS
        // over a clean project (`launchWithFile.ts`) - it's the identical
        // question ("swap the open project for this file?") asked by a
        // different trigger, so every `.stalx`-open entry point (picker,
        // drag-drop, Ctrl+O, and the launch channel) now shares one dialog.
        // Confirming re-enters here with `swapConfirmed: true` so the second
        // pass falls through to loadProject instead of asking again.
        ui.openDialog('launch-open-confirm', { path, fileName: extractFilename(path) });
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
        openImportAsNewProject(ui, path);
        handedOff = true;
        return;
      }
      const gpxFile = await store.parseGpx(path);
      if (!gpxFile) return;
      ui.setImportContext('new-project');
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
        openImportAsNewProject(ui, path);
        handedOff = true;
        return;
      }
      const tmlFile = await store.parseTml(path);
      if (!tmlFile) return;
      // Mirror the DMP branch: the project about to be created exists only for
      // this import, and the import dialog has to know that to offer to discard
      // it again if the import is cancelled or fails (#411 C2).
      ui.setImportContext('new-project');
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
        openImportAsNewProject(ui, path);
        handedOff = true;
        return;
      }
      const compassFile = await store.parseCompass(path);
      if (!compassFile) return;
      ui.setImportContext('new-project');
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
        openImportAsNewProject(ui, path);
        handedOff = true;
        return;
      }
      const wallsFile = await store.parseWalls(path);
      if (!wallsFile) return;
      ui.setImportContext('new-project');
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
      // Re-read project state fresh after the parse - the existing/new-project
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
      // Unknown/unsupported extension - don't blindly assume DMP (that fed
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
    selected = await openDialog({ multiple: false, filters });
  } catch (err) {
    // The native picker itself failed (plugin/permission error) - `open()`
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
