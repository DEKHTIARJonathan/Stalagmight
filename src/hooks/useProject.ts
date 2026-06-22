import { useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { exists } from '@tauri-apps/plugin-fs';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import { getErrorMessage } from '../utils/ipc';
import { extractFilename } from '../utils/path';
import { surfaceSaveFailure } from '../utils/saveFeedback';
import {
  ensureExtension,
  projectOpenFilters,
  projectSaveFilters,
  dmpOpenFilters,
  tmlOpenFilters,
  compassOpenFilters,
  gpxOpenFilters,
  exportSaveFilters,
  saveDialog,
  PROJECT_EXTENSION,
} from '../utils/fileDialogs';
import { openOrImport } from '../utils/openOrImport';
import { clearProjectActionSource } from '../utils/telemetry';
import { debugLog } from '../utils/debugLog';

export function useProject() {
  const store = useProjectStore();
  const { setView, openDialog, setImportContext } = useUIStore();

  const handleNewProject = useCallback(() => {
    // Show the new project dialog which handles name input
    openDialog('new-project');
  }, [openDialog]);

  const handleOpenProject = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: projectOpenFilters(),
    });

    debugLog('[useProject] Open dialog result:', selected, typeof selected);

    // Handle both string and single-item array returns
    let path: string | null = null;
    if (typeof selected === 'string') {
      path = selected;
    } else if (Array.isArray(selected) && (selected as string[]).length > 0) {
      path = (selected as string[])[0] ?? null;
    }

    if (path) {
      debugLog('[useProject] Opening project via loadProject:', path);
      // loadProject handles view switching and error display internally via LoadingProgress
      const result = await store.loadProject(path);
      debugLog('[useProject] loadProject result:', result);
      return result;
    }
    // Picker cancelled — drop any entry-point source set by the caller.
    clearProjectActionSource();
    return null;
  }, [store]);

  const handleSaveProjectAs = useCallback(async (opts?: { closeAfterSave?: boolean }) => {
    const selected = await saveDialog({
      filters: projectSaveFilters(),
    });

    if (selected) {
      const finalPath = ensureExtension(selected, PROJECT_EXTENSION);

      // Check if file already exists
      try {
        const fileExists = await exists(finalPath);
        if (fileExists) {
          // Show confirmation dialog - store the path for later use. Carry the
          // caller's "close after a successful save" intent (Save and Close) so
          // the deferred overwrite-confirm flow still closes the project once it
          // saves — otherwise the close half is silently dropped.
          openDialog('confirm-overwrite', {
            path: finalPath,
            fileName: finalPath.split('/').pop() ?? finalPath,
            closeAfterSave: opts?.closeAfterSave ?? false,
          });
          return null; // Dialog will handle the actual save
        }
      } catch {
        // If exists check fails, proceed with save (backend will handle errors)
      }

      const result = await store.saveProject(finalPath);
      // surfaceSaveFailure routes integrity blocks to Review & Repair and skips
      // the generic error window for permission denials (saveProject already
      // opened the folder-access guidance dialog for those).
      if (result && !result.success && result.error) {
        surfaceSaveFailure(result.error, openDialog);
      }
      return result;
    }
    return null;
  }, [store, openDialog]);

  const handleSaveProject = useCallback(async (opts?: { closeAfterSave?: boolean }) => {
    const result = store.project?.file_path
      ? await store.saveProject()
      : await handleSaveProjectAs(opts);

    if (result && !result.success) {
      surfaceSaveFailure(result.error, openDialog);
    }
    return result;
  }, [store, handleSaveProjectAs, openDialog]);

  const handleCloseProject = useCallback(async () => {
    // Check for unsaved changes - use getState() to get current value, not stale closure
    const currentIsDirty = useProjectStore.getState().isDirty;
    debugLog('[useProject] handleCloseProject called, isDirty:', currentIsDirty);
    if (currentIsDirty) {
      // Open styled dialog - the dialog will handle the actual close
      openDialog('unsaved-changes');
      return { success: false, error: 'Showing dialog' };
    }

    // [perf] Instrument the back path so we can see where the back-button
    // freeze lives. Surfaced in the MemoryProbe panel for visibility
    // without devtools. We measure four checkpoints to pinpoint the freeze:
    //   t0→t1  closeProject IPC roundtrip
    //   t1→t2  setView store update (synchronous)
    //   t2→t3  first rAF after setView (= React commit + layout queued)
    //   t3→t4  next rAF = AFTER first paint (browser had time to repaint)
    // If t3→t4 is huge, the freeze is in JSC GC / paint between commit and
    // visible update — the classic "old screen frozen, then snaps" symptom.
    const t0 = performance.now();
    // Concurrency guard is handled at store level (store.isClosing)
    const result = await store.closeProject();
    const t1 = performance.now();
    if (result.success) {
      setView('global');
    }
    const t2 = performance.now();
    const { recordPerfTiming } = await import('../utils/memoryProbe');
    requestAnimationFrame(() => {
      const t3 = performance.now();
      requestAnimationFrame(() => {
        const t4 = performance.now();
        const closeMs = t1 - t0;
        const toRafMs = t3 - t2;
        const rafToPaintMs = t4 - t3;
        const totalMs = t4 - t0;
        debugLog(
          `[perf:close] closeProject=${closeMs.toFixed(0)}ms  toRAF=${toRafMs.toFixed(0)}ms  rAF→paint=${rafToPaintMs.toFixed(0)}ms  total=${totalMs.toFixed(0)}ms`
        );
        recordPerfTiming('closeProject IPC', closeMs);
        recordPerfTiming('setView→firstRAF', toRafMs);
        recordPerfTiming('rAF→actual paint', rafToPaintMs);
        recordPerfTiming('back total', totalMs);
      });
    });
    return result;
  }, [store, setView, openDialog]);

  /**
   * Handle DMP file import with context-aware dialog flow.
   * - From home screen (no project): Opens file picker, parses DMP, then shows NewProjectDialog,
   *   which on completion opens DmpSelectionDialog.
   * - From existing project: Opens file picker, parses DMP, then opens DmpSelectionDialog directly.
   *
   * @param skipFilePicker - If true, skip the file picker (used for drag-drop with pre-selected file)
   * @param filePath - Pre-selected file path (used with skipFilePicker=true)
   */
  const handleImportDmp = useCallback(async (skipFilePicker = false, filePath?: string) => {
    let selectedPath = filePath;

    if (!skipFilePicker) {
      const selected = await open({
        multiple: false,
        filters: dmpOpenFilters(),
      });

      if (!selected || typeof selected !== 'string') {
        return;
      }
      selectedPath = selected;
    }

    if (!selectedPath) return;

    // Determine context: are we creating a new project or adding to existing?
    const hasProject = !!store.project;

    if (hasProject) {
      // Existing project: parse DMP and open Step 1 (selection) directly
      setImportContext('existing-project');

      try {
        const dmpFile = await store.importDmp(selectedPath);
        if (dmpFile) {
          openDialog('dmp-selection', {
            dmpFile,
            filePath: selectedPath,
          });
        }
      } catch (e) {
        openDialog('error', {
          title: 'Import Failed',
          message: getErrorMessage(e, 'Failed to parse DMP file'),
        });
      }
    } else {
      // No project: parse DMP first, then show NewProjectDialog for import
      // The dialog will handle transitioning to DmpSelectionDialog after project creation
      setImportContext('new-project');

      try {
        const dmpFile = await store.importDmp(selectedPath);
        if (dmpFile) {
          // Extract filename for default project name
          const fileName = extractFilename(selectedPath, /\.dmp$/i) || 'Imported';
          openDialog('new-project-for-import', {
            dmpFile,
            filePath: selectedPath,
            defaultName: fileName,
          });
        }
      } catch (e) {
        openDialog('error', {
          title: 'Import Failed',
          message: getErrorMessage(e, 'Failed to parse DMP file'),
        });
      }
    }
  }, [store, openDialog, setImportContext]);

  /**
   * Handle TML/TMLU file import. A full survey import always creates a new
   * project, so it is only allowed from the home screen (no project open).
   */
  const handleImportTml = useCallback(async (skipFilePicker = false, filePath?: string) => {
    if (store.project) {
      openDialog('error', {
        title: 'Import survey',
        message: 'Close the current project before importing a new survey.',
      });
      return;
    }

    let selectedPath = filePath;

    if (!skipFilePicker) {
      const selected = await open({
        multiple: false,
        filters: tmlOpenFilters(),
      });

      if (!selected || typeof selected !== 'string') {
        return;
      }
      selectedPath = selected;
    }

    if (!selectedPath) return;

    try {
      const tmlFile = await store.parseTml(selectedPath);
      if (!tmlFile) return;

      const fileName = extractFilename(selectedPath, /\.tmlu?$/i) || 'Imported';
      openDialog('new-project-for-import', {
        tmlFile,
        filePath: selectedPath,
        defaultName: fileName,
        importType: 'tml',
      });
    } catch (e) {
      openDialog('error', {
        title: 'Import Failed',
        message: getErrorMessage(e, 'Failed to parse TML file'),
      });
    }
  }, [store, openDialog]);

  /**
   * Handle Compass .DAT/.MAK import. Like TML, a Compass survey import always
   * creates a new project, so it is only allowed when no project is open.
   */
  const handleImportCompass = useCallback(async (skipFilePicker = false, filePath?: string) => {
    if (store.project) {
      openDialog('error', {
        title: 'Import survey',
        message: 'Close the current project before importing a new survey.',
      });
      return;
    }

    let selectedPath = filePath;

    if (!skipFilePicker) {
      const selected = await open({
        multiple: false,
        filters: compassOpenFilters(),
      });

      if (!selected || typeof selected !== 'string') {
        return;
      }
      selectedPath = selected;
    }

    if (!selectedPath) return;

    try {
      const compassFile = await store.parseCompass(selectedPath);
      if (!compassFile) return;

      const fileName = extractFilename(selectedPath, /\.(mak|dat)$/i) || 'Imported';
      openDialog('new-project-for-import', {
        compassFile,
        filePath: selectedPath,
        defaultName: fileName,
        importType: 'compass',
      });
    } catch (e) {
      openDialog('error', {
        title: 'Import Failed',
        message: getErrorMessage(e, 'Failed to parse Compass file'),
      });
    }
  }, [store, openDialog]);

  /**
   * Handle GPX file import with context-aware dialog flow.
   * - From existing project: Opens file picker, parses GPX, then shows GpxSelectionDialog.
   * - From home screen (no project): Opens file picker, parses GPX, then shows NewProjectDialog,
   *   which on completion opens GpxSelectionDialog.
   */
  const handleImportGpx = useCallback(async (skipFilePicker = false, filePath?: string) => {
    let selectedPath = filePath;

    if (!skipFilePicker) {
      const selected = await open({
        multiple: false,
        filters: gpxOpenFilters(),
      });

      if (!selected || typeof selected !== 'string') {
        return;
      }
      selectedPath = selected;
    }

    if (!selectedPath) return;

    const hasProject = !!store.project;

    try {
      const gpxFile = await store.parseGpx(selectedPath);
      if (!gpxFile) return;

      if (hasProject) {
        openDialog('gpx-selection', {
          gpxFile,
          filePath: selectedPath,
        });
      } else {
        const fileName = extractFilename(selectedPath, /\.gpx$/i) || 'Imported';
        openDialog('new-project-for-import', {
          gpxFile,
          filePath: selectedPath,
          defaultName: fileName,
          importType: 'gpx',
        });
      }
    } catch (e) {
      openDialog('error', {
        title: 'Import Failed',
        message: getErrorMessage(e, 'Failed to parse GPX file'),
      });
    }
  }, [store, openDialog]);

  /**
   * Unified "Open / Import": opens a picker accepting native projects and every
   * importable format, then routes the chosen file to the matching flow
   * (open `.stalx`, or import DMP/Ariane/Compass/GPX) based on its extension.
   */
  const handleOpenOrImport = useCallback(() => openOrImport(), []);

  const handleExportCsv = useCallback(async () => {
    const selected = await saveDialog({
      filters: exportSaveFilters('CSV', 'csv'),
    });

    if (selected) {
      try {
        await store.exportCsv(ensureExtension(selected, 'csv'));
      } catch (e) {
        console.error('Failed to export CSV:', e);
      }
    }
  }, [store]);

  const handleExportJson = useCallback(async () => {
    const selected = await saveDialog({
      filters: exportSaveFilters('JSON', 'json'),
    });

    if (selected) {
      try {
        await store.exportJson(ensureExtension(selected, 'json'));
      } catch (e) {
        console.error('Failed to export JSON:', e);
      }
    }
  }, [store]);

  return {
    project: store.project,
    stats: store.stats,
    stations: store.stations,
    recentProjects: store.recentProjects,
    isLoading: store.loading.isLoading,
    loading: store.loading,
    error: store.error,
    canUndo: store.canUndo,
    canRedo: store.canRedo,

    handleNewProject,
    handleOpenProject,
    handleOpenOrImport,
    handleSaveProject,
    handleSaveProjectAs,
    handleCloseProject,
    handleImportDmp,
    handleImportTml,
    handleImportCompass,
    handleImportGpx,
    handleExportCsv,
    handleExportJson,

    undo: store.undo,
    redo: store.redo,
  };
}
