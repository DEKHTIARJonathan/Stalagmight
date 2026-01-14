import { useEffect } from 'react';
import { useProjectStore } from './store/projectStore';
import { useUIStore } from './store/uiStore';
import GlobalView from './components/GlobalView/GlobalView';
import SingleSystemView from './components/SingleSystemView/SingleSystemView';
import { ImportDialog, ExportDialog } from './components/Dialogs';

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
    </div>
  );
}

export default App;
