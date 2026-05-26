import { useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { exists } from '@tauri-apps/plugin-fs';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import { getErrorMessage } from '../utils/ipc';
import { extractFilename } from '../utils/path';
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

    console.log('[useProject] Open dialog result:', selected, typeof selected);

    // Handle both string and single-item array returns
    let path: string | null = null;
    if (typeof selected === 'string') {
      path = selected;
    } else if (Array.isArray(selected) && (selected as string[]).length > 0) {
      path = (selected as string[])[0] ?? null;
    }

    if (path) {
      console.log('[useProject] Opening project via loadProject:', path);
      // loadProject handles view switching and error display internally via LoadingProgress
      const result = await store.loadProject(path);
      console.log('[useProject] loadProject result:', result);
      return result;
    }
    return null;
  }, [store]);

  const handleSaveProjectAs = useCallback(async () => {
    const selected = await saveDialog({
      filters: projectSaveFilters(),
    });

    if (selected) {
      const finalPath = ensureExtension(selected, PROJECT_EXTENSION);

      // Check if file already exists
      try {
        const fileExists = await exists(finalPath);
        if (fileExists) {
          // Show confirmation dialog - store the path for later use
          openDialog('confirm-overwrite', {
            path: finalPath,
            fileName: finalPath.split('/').pop() ?? finalPath,
          });
          return null; // Dialog will handle the actual save
        }
      } catch {
        // If exists check fails, proceed with save (backend will handle errors)
      }

      const result = await store.saveProject(finalPath);
      if (result && !result.success && result.error) {
        openDialog('error', { message: result.error, title: 'Save Failed' });
      }
      return result;
    }
    return null;
  }, [store, openDialog]);

  const handleSaveProject = useCallback(async () => {
    const result = store.project?.file_path
      ? await store.saveProject()
      : await handleSaveProjectAs();

    if (result && !result.success && result.error) {
      openDialog('error', { message: result.error, title: 'Save Failed' });
    }
    return result;
  }, [store, handleSaveProjectAs, openDialog]);

  const handleCloseProject = useCallback(async () => {
    // Check for unsaved changes - use getState() to get current value, not stale closure
    const currentIsDirty = useProjectStore.getState().isDirty;
    console.log('[useProject] handleCloseProject called, isDirty:', currentIsDirty);
    if (currentIsDirty) {
      // Open styled dialog - the dialog will handle the actual close
      openDialog('unsaved-changes');
      return { success: false, error: 'Showing dialog' };
    }

    // Concurrency guard is handled at store level (store.isClosing)
    const result = await store.closeProject();
    if (result.success) {
      setView('global');
    }
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
