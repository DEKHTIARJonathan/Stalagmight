import { useCallback } from 'react';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useProject } from '../../hooks/useProject';
import { useAutoSave, type AutoSaveStatus } from '../../hooks/useAutoSave';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { useShallow } from 'zustand/react/shallow';
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
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';

export default function SingleSystemView() {
  const { t } = useTranslation();
  const precision = useDecimalPrecision();
  useKeyboardShortcuts();

  const {
    project,
    stats,
    handleSaveProject: rawSave,
    handleCloseProject,
    handleImportDmp,
    canUndo,
    canRedo,
    undo,
    redo,
  } = useProject();

  const isDirty = useProjectStore((s) => s.isDirty);
  const autoSave = useAutoSave();

  const handleSaveProject = useCallback(async () => {
    autoSave.cancelPending();
    return rawSave();
  }, [autoSave, rawSave]);

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
  } = useUIStore(useShallow((s) => ({
    sectionsPanelOpen: s.sectionsPanelOpen,
    sectionsPanelWidth: s.sectionsPanelWidth,
    detailPanelOpen: s.detailPanelOpen,
    detailPanelWidth: s.detailPanelWidth,
    dataTableOpen: s.dataTableOpen,
    dataTableHeight: s.dataTableHeight,
    setSectionsPanelWidth: s.setSectionsPanelWidth,
    setDetailPanelWidth: s.setDetailPanelWidth,
    setDataTableHeight: s.setDataTableHeight,
    savePanelSizes: s.savePanelSizes,
  })));

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
            length: formatLength(stats?.total_length ?? 0, precision.length),
          })}
        </span>
        <SaveStatus status={autoSave.status} countdown={autoSave.countdown} isDirty={isDirty} />
      </footer>
    </div>
  );
}

function SaveStatus({
  status,
  countdown,
  isDirty,
}: {
  status: AutoSaveStatus;
  countdown: number;
  isDirty: boolean;
}) {
  const { t } = useTranslation();

  let text: string;
  let className = '';

  switch (status) {
    case 'saving':
      text = t('singleView.status.saving');
      break;
    case 'saved':
      text = t('singleView.status.saved');
      break;
    case 'pending':
      text = t('singleView.status.autoSaveCountdown', { seconds: countdown });
      break;
    case 'error':
      text = t('singleView.status.saveError');
      className = 'text-red-400';
      break;
    case 'idle':
    default:
      text = isDirty
        ? t('singleView.status.unsavedChanges')
        : t('singleView.status.saved');
      if (isDirty) className = 'text-yellow-400';
      break;
  }

  return (
    <span data-testid="save-status" className={className}>
      {text}
    </span>
  );
}

function formatLength(meters: number, lengthPrecision: number): string {
  if (meters >= 1000) {
    return `${formatFixed(meters / 1000, undefined, lengthPrecision)} km`;
  }
  return `${formatFixed(meters, undefined, lengthPrecision)} m`;
}

