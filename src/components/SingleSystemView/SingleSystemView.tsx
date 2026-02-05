import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useProject } from '../../hooks/useProject';
import { useUIStore } from '../../store/uiStore';
import { ResizablePanel } from '../common/Panel';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { OfflineIndicator } from '../common/OfflineIndicator';
import Toolbar from './Toolbar';
import SectionsPanel from './SectionsPanel';
import DetailPanel from './DetailPanel';
import DataTable from './DataTable';
import MapCanvas from '../Map/MapCanvas';
import { useTranslation } from 'react-i18next';
import { formatFixed, formatNumber } from '../../i18n/format';

export default function SingleSystemView() {
  const { t } = useTranslation();
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
    savePanelSizes,
  } = useUIStore();

  if (!project) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-text-secondary">{t('singleView.empty')}</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" data-testid="single-system-view">
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
            onResizeEnd={(size) => savePanelSizes(size, undefined, undefined)}
            className="border-r border-border"
          >
            <ErrorBoundary panelName="Sections">
              <SectionsPanel sections={project.sections} />
            </ErrorBoundary>
          </ResizablePanel>
        )}

        {/* Map and data table */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Map */}
          <div className="flex-1 relative">
            <ErrorBoundary panelName="Map">
              <MapCanvas />
            </ErrorBoundary>
            {/* Offline indicator - positioned in top-right of map area */}
            <OfflineIndicator className="absolute top-2 right-14" />
          </div>

          {/* Data table */}
          {dataTableOpen && (
            <ResizablePanel
              direction="vertical"
              defaultSize={dataTableHeight}
              minSize={100}
              maxSize={500}
              onResize={setDataTableHeight}
              onResizeEnd={(size) => savePanelSizes(undefined, undefined, size)}
              className="border-t border-border"
            >
              <ErrorBoundary panelName="Data Table">
                <DataTable sections={project.sections} />
              </ErrorBoundary>
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
            onResizeEnd={(size) => savePanelSizes(undefined, size, undefined)}
            handlePosition="start"
            className="border-l border-border"
          >
            <ErrorBoundary panelName="Details">
              <DetailPanel />
            </ErrorBoundary>
          </ResizablePanel>
        )}
      </div>

      {/* Status bar */}
      <footer className="px-4 py-2 border-t border-border text-sm text-text-secondary flex justify-between">
        <span>
          {t('singleView.status.summary', {
            sections: formatNumber(stats?.section_count ?? 0),
            shots: formatNumber(stats?.shot_count ?? 0),
            length: formatLength(stats?.total_length ?? 0),
          })}
        </span>
        <span>
          {t('singleView.status.depthRange', {
            min: formatDepth(stats?.min_depth ?? 0),
            max: formatDepth(stats?.max_depth ?? 0),
          })}
        </span>
      </footer>
    </div>
  );
}

function formatLength(meters: number): string {
  if (meters >= 1000) {
    return `${formatFixed(meters / 1000, undefined, 2)} km`;
  }
  return `${formatFixed(meters, undefined, 1)} m`;
}

function formatDepth(meters: number): string {
  return `${formatFixed(meters, undefined, 1)} m`;
}
