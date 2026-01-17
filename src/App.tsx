import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useProjectStore } from './store/projectStore';
import { useUIStore } from './store/uiStore';
import GlobalView from './components/GlobalView/GlobalView';
import SingleSystemView from './components/SingleSystemView/SingleSystemView';
import { ImportDialog, ExportDialog, NewProjectDialog, DmpImportDialog, ConfirmDialog, MergeDialog, DrawShotDialog, EditSectionDialog, EditShotDialog, EditStationDialog, UnsavedChangesDialog, ErrorDialog, OverwriteConfirmDialog, SectionAdjustDialog } from './components/Dialogs';
import { ContextMenu } from './components/common';

function App() {
  const { project, loadConfig, config, isDirty } = useProjectStore();
  const { view, activeDialog, initPanelSizes } = useUIStore();

  useEffect(() => {
    // Load config on startup
    loadConfig();
  }, [loadConfig]);

  // Initialize panel sizes from config
  useEffect(() => {
    if (config?.panels) {
      initPanelSizes(config.panels);
    }
  }, [config, initPanelSizes]);

  // Update window title based on project state
  useEffect(() => {
    const updateTitle = async () => {
      let title = 'CaveChef';
      if (project) {
        if (project.file_path) {
          // Extract filename from path
          const filename = project.file_path.split(/[/\\]/).pop() ?? project.file_path;
          title = `CaveChef - ${filename}`;
        } else {
          title = `CaveChef - ${project.name} (unsaved)`;
        }
        if (isDirty) {
          title = `${title} *`;
        }
      }
      try {
        await getCurrentWindow().setTitle(title);
      } catch (e) {
        // Fallback for dev mode or if Tauri API unavailable
        document.title = title;
      }
    };
    updateTitle();
  }, [project, project?.file_path, project?.name, isDirty]);

  return (
    <div className="h-full bg-background text-text-primary flex flex-col">
      {view === 'global' || !project ? (
        <GlobalView />
      ) : (
        <SingleSystemView />
      )}

      {/* Dialogs */}
      {activeDialog === 'import' && <ImportDialog />}
      {activeDialog === 'export' && <ExportDialog />}
      {activeDialog === 'new-project' && <NewProjectDialog />}
      {activeDialog === 'import-dmp' && <DmpImportDialog />}
      {activeDialog === 'confirm-delete' && <ConfirmDialog />}
      {activeDialog === 'merge' && <MergeDialog />}
      {activeDialog === 'draw-shot' && <DrawShotDialog />}
      {activeDialog === 'edit-section' && <EditSectionDialog />}
      {activeDialog === 'edit-shot' && <EditShotDialog />}
      {activeDialog === 'edit-station' && <EditStationDialog />}
      {activeDialog === 'unsaved-changes' && <UnsavedChangesDialog />}
      {activeDialog === 'error' && <ErrorDialog />}
      {activeDialog === 'confirm-overwrite' && <OverwriteConfirmDialog />}
      {activeDialog === 'context-menu' && <ContextMenu />}
      {activeDialog === 'section-adjust' && <SectionAdjustDialog />}
    </div>
  );
}

export default App;
