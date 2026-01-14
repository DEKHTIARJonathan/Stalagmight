import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useProject } from '../../hooks/useProject';
import { useUIStore } from '../../store/uiStore';
import { ResizablePanel } from '../common/Panel';
import Toolbar from './Toolbar';
import SectionsPanel from './SectionsPanel';
import DetailPanel from './DetailPanel';
import DataTable from './DataTable';
import MapCanvas from '../Map/MapCanvas';

export default function SingleSystemView() {
  useKeyboardShortcuts();

  const {
    project,
    stats,
    handleSaveProject,
    handleCloseProject,
    handleImportDmp,
    canUndo,
    canRedo,
    undo,
    redo,
  } = useProject();

  const {
    sectionsPanelOpen,
    sectionsPanelWidth,
    detailPanelOpen,
    detailPanelWidth,
    dataTableOpen,
    dataTableHeight,
    setSectionsPanelWidth,
    setDetailPanelWidth,
    setDataTableHeight,
  } = useUIStore();

  if (!project) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-text-secondary">No project open</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <Toolbar
        projectName={project.name}
        onBack={handleCloseProject}
        onSave={handleSaveProject}
        onImport={handleImportDmp}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
      />

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sections panel */}
        {sectionsPanelOpen && (
          <ResizablePanel
            direction="horizontal"
            defaultSize={sectionsPanelWidth}
            minSize={150}
            maxSize={400}
            onResize={setSectionsPanelWidth}
            className="border-r border-border"
          >
            <SectionsPanel sections={project.sections} />
          </ResizablePanel>
        )}

        {/* Map and data table */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Map */}
          <div className="flex-1 relative">
            <MapCanvas />
          </div>

          {/* Data table */}
          {dataTableOpen && (
            <ResizablePanel
              direction="vertical"
              defaultSize={dataTableHeight}
              minSize={100}
              maxSize={500}
              onResize={setDataTableHeight}
              className="border-t border-border"
            >
              <DataTable sections={project.sections} />
            </ResizablePanel>
          )}
        </div>

        {/* Detail panel */}
        {detailPanelOpen && (
          <ResizablePanel
            direction="horizontal"
            defaultSize={detailPanelWidth}
            minSize={200}
            maxSize={500}
            onResize={setDetailPanelWidth}
            className="border-l border-border"
          >
            <DetailPanel />
          </ResizablePanel>
        )}
      </div>

      {/* Status bar */}
      <footer className="px-4 py-2 border-t border-border text-sm text-text-secondary flex justify-between">
        <span>
          Sections: {stats?.section_count ?? 0} | Shots: {stats?.shot_count ?? 0} |
          Length: {formatLength(stats?.total_length ?? 0)}
        </span>
        <span>
          Depth: {formatDepth(stats?.min_depth ?? 0)} - {formatDepth(stats?.max_depth ?? 0)}
        </span>
      </footer>
    </div>
  );
}

function formatLength(meters: number): string {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(2)} km`;
  }
  return `${meters.toFixed(1)} m`;
}

function formatDepth(meters: number): string {
  return `${meters.toFixed(1)} m`;
}
