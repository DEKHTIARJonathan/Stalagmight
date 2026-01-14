import { useEffect } from 'react';
import { useProjectStore } from './store/projectStore';
import { useUIStore } from './store/uiStore';
import GlobalView from './components/GlobalView/GlobalView';
import SingleSystemView from './components/SingleSystemView/SingleSystemView';
import { ImportDialog, ExportDialog, NewProjectDialog, DmpImportDialog, ConfirmDialog, MergeDialog, DrawShotDialog, EditSectionDialog, EditShotDialog, EditStationDialog } from './components/Dialogs';
import { ContextMenu } from './components/common';

function App() {
  const { project, loadConfig } = useProjectStore();
  const { view, activeDialog } = useUIStore();

  useEffect(() => {
    // Load config on startup
    loadConfig();
  }, [loadConfig]);

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
      {activeDialog === 'context-menu' && <ContextMenu />}
    </div>
  );
}

export default App;
