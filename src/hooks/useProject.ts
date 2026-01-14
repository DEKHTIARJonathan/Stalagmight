import { useCallback } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';

export function useProject() {
  const store = useProjectStore();
  const { setView, openDialog } = useUIStore();

  const handleNewProject = useCallback(async () => {
    // TODO: Show new project dialog
    const name = 'New Project'; // Should come from dialog
    const result = await store.createProject(name);
    if (result.success) {
      setView('single');
    }
    return result;
  }, [store, setView]);

  const handleOpenProject = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Cave Project', extensions: ['cave'] }],
    });

    if (selected && typeof selected === 'string') {
      const result = await store.openProject(selected);
      if (result.success) {
        setView('single');
      }
      return result;
    }
    return null;
  }, [store, setView]);

  const handleSaveProjectAs = useCallback(async () => {
    const selected = await save({
      filters: [{ name: 'Cave Project', extensions: ['cave'] }],
    });

    if (selected) {
      return await store.saveProject(selected);
    }
    return null;
  }, [store]);

  const handleSaveProject = useCallback(async () => {
    if (store.project?.file_path) {
      return await store.saveProject();
    }
    return await handleSaveProjectAs();
  }, [store, handleSaveProjectAs]);

  const handleCloseProject = useCallback(async () => {
    // Check for unsaved changes
    if (store.isDirty) {
      const confirmed = window.confirm(
        'You have unsaved changes. Are you sure you want to go back? Your changes will be lost.'
      );
      if (!confirmed) {
        return { success: false, error: 'Cancelled' };
      }
    }

    const result = await store.closeProject();
    if (result.success) {
      setView('global');
    }
    return result;
  }, [store, setView]);

  const handleImportDmp = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'mNemo DMP', extensions: ['dmp'] }],
    });

    if (selected && typeof selected === 'string') {
      // Open the import dialog with the file path
      openDialog('import-dmp', { filePath: selected });
    }
  }, [openDialog]);

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
