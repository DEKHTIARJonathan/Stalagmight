import { useCallback, useEffect, useRef } from 'react';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useProject } from '../../hooks/useProject';
import { useAutoSave, type AutoSaveStatus } from '../../hooks/useAutoSave';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import type { SectionId } from '../../types/project';
import { useShallow } from 'zustand/react/shallow';
import { ResizablePanel } from '../common/Panel';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { OfflineIndicator } from '../common/OfflineIndicator';
import Toolbar from './Toolbar';
import SectionsPanel from './SectionsPanel';
import DetailPanel from './DetailPanel';
import DataTable from './DataTable';
import MapCanvas from '../Map/MapCanvas';
import { DATA_TABLE_MIN_HEIGHT, DATA_TABLE_MAX_HEIGHT } from './layoutConstants';
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon } from '../common/icons';
import { setSource, withTrackingSuppressed } from '../../utils/telemetry';
import { useTranslation } from 'react-i18next';
import { formatFixed, formatNumber } from '../../i18n/format';
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';

// #50: after double-click collapses the side panels, the map grows. fitToSection
// reads the container size at call time, so re-fit once the layout has reflowed
// and MapLibre's ResizeObserver has resized the map (a couple of frames). This
// lives here rather than in SectionsPanel, which unmounts when it collapses.
const SECTION_FOCUS_REFIT_DELAY_MS = 180;

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
  const placementModeActive = useUIStore((s) => s.placementMode !== null);

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
    focusedSectionId,
    exitSectionFocus,
    setFocusedSection,
    selection,
    triggerZoomToSection,
    triggerFitToBounds,
    toggleSectionsPanel,
    toggleDetailPanel,
    toggleDataTable,
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
    focusedSectionId: s.focusedSectionId,
    exitSectionFocus: s.exitSectionFocus,
    setFocusedSection: s.setFocusedSection,
    selection: s.selection,
    triggerZoomToSection: s.triggerZoomToSection,
    triggerFitToBounds: s.triggerFitToBounds,
    toggleSectionsPanel: s.toggleSectionsPanel,
    toggleDetailPanel: s.toggleDetailPanel,
    toggleDataTable: s.toggleDataTable,
    setSectionsPanelWidth: s.setSectionsPanelWidth,
    setDetailPanelWidth: s.setDetailPanelWidth,
    setDataTableHeight: s.setDataTableHeight,
    savePanelSizes: s.savePanelSizes,
  })));

  // #50: name shown in place of the project name while focused on one section.
  const focusedSectionExists =
    focusedSectionId !== null && (project?.sections.some((s) => s.id === focusedSectionId) ?? false);
  const focusedSectionName =
    focusedSectionId !== null
      ? project?.sections.find((s) => s.id === focusedSectionId)?.name
          ?? t('sections.defaultName', { id: focusedSectionId })
      : null;

  // The section that owns the current selection (section / shot / station) — the
  // same mapping the data table uses to pick its section.
  const selectedSectionId: SectionId | undefined =
    selection?.type === 'section' || selection?.type === 'shot'
      ? selection.sectionId
      : selection?.type === 'station'
        ? selection.stationRef?.section_id
        : undefined;

  // #50: adjust the map once the layout settles, after the side panels collapse
  // (entry) or return (exit). ENTRY (null -> id) frames the focused section in the
  // enlarged map; EXIT (id -> null) returns to a neutral whole-map overview
  // (fit-to-bounds) rather than staying zoomed into the section. NOT on a follow
  // (id -> id'), so clicking another section never re-zooms — consistent with
  // single-click no longer moving the map. Lives here (not in SectionsPanel,
  // which unmounts on collapse) so the timer survives the panel mount/unmount.
  const prevFocusedRef = useRef<SectionId | null>(null);
  useEffect(() => {
    const prev = prevFocusedRef.current;
    prevFocusedRef.current = focusedSectionId;
    const transition =
      prev === null && focusedSectionId !== null
        ? 'enter'
        : prev !== null && focusedSectionId === null
          ? 'exit'
          : null; // follow / no transition
    if (transition === null) return;
    const enterId = focusedSectionId;
    const timer = window.setTimeout(() => {
      setSource('sections-panel');
      if (transition === 'enter' && enterId !== null) {
        triggerZoomToSection(enterId);
      } else {
        triggerFitToBounds();
      }
    }, SECTION_FOCUS_REFIT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [focusedSectionId, triggerZoomToSection, triggerFitToBounds]);

  // #50: while focused, follow the selected section so the toolbar heading tracks
  // the data table (clicking another section on the map updates both).
  useEffect(() => {
    if (
      focusedSectionId !== null &&
      selectedSectionId !== undefined &&
      selectedSectionId !== focusedSectionId
    ) {
      setFocusedSection(selectedSectionId);
    }
  }, [focusedSectionId, selectedSectionId, setFocusedSection]);

  // #50: if the focused section disappears (e.g. deleted while focused), exit
  // focus mode rather than stay in the collapsed layout showing a stale name.
  useEffect(() => {
    if (focusedSectionId !== null && project && !focusedSectionExists) {
      exitSectionFocus();
    }
  }, [focusedSectionId, focusedSectionExists, project, exitSectionFocus]);

  const sectionsPanelOpenedByOnboardingRef = useRef(false);
  const detailPanelOpenedByOnboardingRef = useRef(false);
  const dataTableOpenedByOnboardingRef = useRef(false);

  // Auto-open Data Table during late SURVEY WORKSPACE steps to avoid
  // a visible tooltip jump when entering the data-table step.
  useEffect(() => {
    const getSingleViewOnboardingStepId = (): string | null => {
      const overlay = document.querySelector('[data-testid="onboarding-overlay"]');
      if (!overlay) {
        return null;
      }
      const flowId = overlay.getAttribute('data-onboarding-flow-id');
      const stepId = overlay.getAttribute('data-onboarding-step-id');
      return flowId === 'single-view-basics' ? stepId : null;
    };

    const syncDataTableState = () => {
      const stepId = getSingleViewOnboardingStepId();
      const shouldShowSectionsPanel = stepId === 'sections';
      const shouldShowDetailPanel = stepId === 'detail-panel';
      const shouldShowDataTable = stepId === 'data-table';

      if (shouldShowSectionsPanel) {
        if (!sectionsPanelOpen) {
          sectionsPanelOpenedByOnboardingRef.current = true;
          withTrackingSuppressed(() => toggleSectionsPanel());
        }
      } else if (sectionsPanelOpenedByOnboardingRef.current && sectionsPanelOpen) {
        sectionsPanelOpenedByOnboardingRef.current = false;
        withTrackingSuppressed(() => toggleSectionsPanel());
      } else if (!shouldShowSectionsPanel) {
        sectionsPanelOpenedByOnboardingRef.current = false;
      }

      if (shouldShowDetailPanel) {
        if (!detailPanelOpen) {
          detailPanelOpenedByOnboardingRef.current = true;
          withTrackingSuppressed(() => toggleDetailPanel());
        }
      } else if (detailPanelOpenedByOnboardingRef.current && detailPanelOpen) {
        detailPanelOpenedByOnboardingRef.current = false;
        withTrackingSuppressed(() => toggleDetailPanel());
      } else if (!shouldShowDetailPanel) {
        detailPanelOpenedByOnboardingRef.current = false;
      }

      if (shouldShowDataTable) {
        if (!dataTableOpen) {
          dataTableOpenedByOnboardingRef.current = true;
          withTrackingSuppressed(() => toggleDataTable());
        }
        return;
      }

      if (dataTableOpenedByOnboardingRef.current && dataTableOpen) {
        dataTableOpenedByOnboardingRef.current = false;
        withTrackingSuppressed(() => toggleDataTable());
        return;
      }

      if (!shouldShowDataTable) {
        dataTableOpenedByOnboardingRef.current = false;
      }
    };

    syncDataTableState();

    if (typeof MutationObserver === 'undefined') {
      return;
    }

    const observer = new MutationObserver(syncDataTableState);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-onboarding-flow-id', 'data-onboarding-step-id'],
    });

    return () => {
      observer.disconnect();
    };
  }, [
    dataTableOpen,
    detailPanelOpen,
    sectionsPanelOpen,
    toggleDataTable,
    toggleDetailPanel,
    toggleSectionsPanel,
  ]);

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
        focusedSectionName={focusedSectionName}
        onBack={handleCloseProject}
        onSave={handleSaveProject}
        onImport={handleImportDmp}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        placementModeActive={placementModeActive}
      />

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sections panel */}
        {sectionsPanelOpen ? (
          <ResizablePanel
            direction="horizontal"
            defaultSize={sectionsPanelWidth}
            minSize={150}
            maxSize={400}
            onResize={setSectionsPanelWidth}
            onResizeEnd={(size) => savePanelSizes(size, undefined, undefined)}
            className="border-r border-border"
          >
            <div className="relative h-full">
              <button
                type="button"
                className="absolute right-0 top-1/2 z-10 -mr-1 h-10 w-3 -translate-y-1/2 rounded-sm border border-border bg-panel text-text-secondary transition-colors hover:bg-background-80"
                onClick={toggleSectionsPanel}
                title={t('dataTable.toggle.collapse')}
                aria-label={t('dataTable.toggle.collapse')}
                data-testid="sections-panel-collapse-toggle"
              >
                <span className="flex h-full items-center justify-center">
                  <ChevronLeftIcon size={10} />
                </span>
              </button>
              <div className={`h-full ${placementModeActive ? 'pointer-events-none select-none opacity-45 grayscale' : ''}`}>
                <ErrorBoundary panelName="Sections">
                  <SectionsPanel sections={project.sections} />
                </ErrorBoundary>
              </div>
            </div>
          </ResizablePanel>
        ) : (
          <button
            type="button"
            className="w-3 flex-shrink-0 border-r border-border bg-panel transition-colors hover:bg-background-80"
            onClick={toggleSectionsPanel}
            title={t('sections.title')}
            aria-label={t('sections.title')}
            data-testid="sections-panel-collapsed-toggle"
          >
            <span className="flex h-full items-center justify-center text-text-secondary">
              <ChevronRightIcon size={10} />
            </span>
          </button>
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
          {dataTableOpen ? (
            <ResizablePanel
              direction="vertical"
              defaultSize={dataTableHeight}
              minSize={DATA_TABLE_MIN_HEIGHT}
              maxSize={DATA_TABLE_MAX_HEIGHT}
              onResize={setDataTableHeight}
              // Don't persist the temporary focus-mode height (#50): in focus
              // mode the data table opens at ~30% and exit restores the prior
              // height only in memory, so persisting a focus-time drag would
              // leak that size into the next session.
              onResizeEnd={(size) => {
                if (focusedSectionId === null) savePanelSizes(undefined, undefined, size);
              }}
              className="border-t border-border"
            >
              <div className="relative h-full">
                <button
                  type="button"
                  className="absolute left-1/2 top-0 z-10 h-3 w-12 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-border bg-panel text-text-secondary transition-colors hover:bg-background-80"
                  onClick={toggleDataTable}
                  title={t('dataTable.toggle.collapse')}
                  aria-label={t('dataTable.toggle.collapse')}
                  data-testid="data-table-open-collapse-toggle"
                >
                  <span className="flex h-full items-center justify-center">
                    <ChevronDownIcon size={10} />
                  </span>
                </button>
                <div className={`h-full ${placementModeActive ? 'pointer-events-none select-none opacity-45 grayscale' : ''}`}>
                  <ErrorBoundary panelName="Data Table">
                    <DataTable sections={project.sections} />
                  </ErrorBoundary>
                </div>
              </div>
            </ResizablePanel>
          ) : (
            <button
              type="button"
              className="h-3 shrink-0 border-t border-border bg-panel transition-colors hover:bg-background-80"
              onClick={toggleDataTable}
              title={t('dataTable.toggle.expand')}
              aria-label={t('dataTable.toggle.expand')}
              data-testid="data-table-collapsed-toggle"
            >
              <span className="flex h-full items-center justify-center text-text-secondary">
                <ChevronUpIcon size={12} />
              </span>
            </button>
          )}
        </div>

        {/* Detail panel */}
        {detailPanelOpen ? (
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
            <div className="relative h-full">
              <button
                type="button"
                className="absolute left-0 top-1/2 z-10 -ml-1 h-10 w-3 -translate-y-1/2 rounded-sm border border-border bg-panel text-text-secondary transition-colors hover:bg-background-80"
                onClick={toggleDetailPanel}
                title={t('dataTable.toggle.collapse')}
                aria-label={t('dataTable.toggle.collapse')}
                data-testid="detail-panel-collapse-toggle"
              >
                <span className="flex h-full items-center justify-center">
                  <ChevronRightIcon size={10} />
                </span>
              </button>
              <div className={placementModeActive ? 'pointer-events-none select-none opacity-45 grayscale' : ''}>
                <ErrorBoundary panelName="Details">
                  <DetailPanel />
                </ErrorBoundary>
              </div>
            </div>
          </ResizablePanel>
        ) : (
          <button
            type="button"
            className="w-3 flex-shrink-0 border-l border-border bg-panel transition-colors hover:bg-background-80"
            onClick={toggleDetailPanel}
            title={t('onboarding.flows.singleView.steps.detailPanel.title')}
            aria-label={t('onboarding.flows.singleView.steps.detailPanel.title')}
            data-testid="detail-panel-collapsed-toggle"
          >
            <span className="flex h-full items-center justify-center text-text-secondary">
              <ChevronLeftIcon size={10} />
            </span>
          </button>
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
          {focusedSectionName !== null && (
            <span data-testid="status-focused-section" className="ml-2 text-accent">
              {' | '}
              {t('singleView.status.focusedSection', { name: focusedSectionName })}
            </span>
          )}
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
