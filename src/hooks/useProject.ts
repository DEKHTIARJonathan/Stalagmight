import { useCallback } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { exists } from '@tauri-apps/plugin-fs';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';

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
      filters: [{ name: 'CaveChef Project', extensions: ['cvproj', 'cvchef'] }],
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
      console.log('[useProject] Opening project:', path);
      const result = await store.openProject(path);
      console.log('[useProject] Open result:', result);
      if (result.success) {
        setView('single');
      } else if (result.error) {
        // Show error to user via dialog
        openDialog('error', { message: result.error });
      }
      return result;
    }
    return null;
  }, [store, setView, openDialog]);

  const handleSaveProjectAs = useCallback(async () => {
    const selected = await save({
      filters: [{ name: 'CaveChef Project', extensions: ['cvproj'] }],
    });

    if (selected) {
      // Ensure .cvproj extension (matching backend logic)
      const finalPath = selected.endsWith('.cvproj') ? selected : `${selected}.cvproj`;

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

      const result = await store.saveProject(selected);
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
        filters: [{ name: 'mNemo DMP', extensions: ['dmp'] }],
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
          message: e instanceof Error ? e.message : 'Failed to parse DMP file',
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
          const fileName = selectedPath.split(/[/\\]/).pop()?.replace(/\.dmp$/i, '') ?? 'Imported';
          openDialog('new-project-for-import', {
            dmpFile,
            filePath: selectedPath,
            defaultName: fileName,
          });
        }
      } catch (e) {
        openDialog('error', {
          title: 'Import Failed',
          message: e instanceof Error ? e.message : 'Failed to parse DMP file',
        });
      }
    }
  }, [store, openDialog, setImportContext]);

  const handleExportCsv = useCallback(async () => {
    const selected = await save({
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });

    if (selected) {
      try {
        await store.exportCsv(selected);
      } catch (e) {
        console.error('Failed to export CSV:', e);
      }
    }
  }, [store]);

  const handleExportJson = useCallback(async () => {
    const selected = await save({
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (selected) {
      try {
        await store.exportJson(selected);
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
    isLoading: store.isLoading,
    error: store.error,
    canUndo: store.canUndo,
    canRedo: store.canRedo,

    handleNewProject,
    handleOpenProject,
    handleSaveProject,
    handleSaveProjectAs,
    handleCloseProject,
    handleImportDmp,
    handleExportCsv,
    handleExportJson,

    undo: store.undo,
    redo: store.redo,
  };
}
