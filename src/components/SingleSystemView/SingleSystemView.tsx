import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
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
import { usePanelReveal } from './usePanelReveal';
import { PanelOpenerTab } from './PanelOpenerTab';
import { PanelFloat } from './PanelFloat';
import { open } from '@tauri-apps/plugin-dialog';
import { dmpGpxOpenFilters } from '../../utils/fileDialogs';
import { useProjectMenuItems } from './useProjectMenuItems';
import { setSource, withTrackingSuppressed, setProjectActionSource, clearProjectActionSource } from '../../utils/telemetry';
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
    handleImportDmp,
    handleImportGpx,
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

  // Toolbar "Import" button: a single picker for the two formats importable into
  // an open project (DMP + GPX), routed by extension.
  const handleImportDmpOrGpx = useCallback(async () => {
    setProjectActionSource('toolbar');
    const selected = await open({ multiple: false, filters: dmpGpxOpenFilters() });
    if (!selected || typeof selected !== 'string') {
      clearProjectActionSource();
      return;
    }
    if (selected.toLowerCase().endsWith('.gpx')) {
      await handleImportGpx(true, selected);
    } else {
      await handleImportDmp(true, selected);
    }
  }, [handleImportDmp, handleImportGpx]);

  // Hamburger menu items (file/project actions). Built here so it can use the
  // autosave-aware wrapped save.
  const menuItems = useProjectMenuItems({ onSave: handleSaveProject });

  const {
    sectionsPanelOpen,
    sectionsPanelWidth,
    detailPanelOpen,
    detailPanelWidth,
    dataTableOpen,
    dataTableHeight,
    dataTableFullScreen,
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
    dataTableFullScreen: s.dataTableFullScreen,
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

  // Two-mode (hover/pin) reveal state for each panel. The store holds the
  // persisted mode/open; these hooks add transient hover visibility + handlers.
  const sectionsReveal = usePanelReveal('sections');
  const detailReveal = usePanelReveal('detail');
  const dataReveal = usePanelReveal('data-table');

  // #50: name shown in place of the project name while focused on one section.
  // A single lookup drives both existence (the auto-exit effect) and the name.
  const focusedSection =
    focusedSectionId !== null
      ? project?.sections.find((s) => s.id === focusedSectionId) ?? null
      : null;
  const focusedSectionExists = focusedSection !== null;
  const focusedSectionName =
    focusedSectionId !== null
      ? focusedSection?.name ?? t('sections.defaultName', { id: focusedSectionId })
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
  const focusedSectionIdRef = useRef<SectionId | null>(focusedSectionId);
  focusedSectionIdRef.current = focusedSectionId;
  const refitTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevFocusedRef.current;
    prevFocusedRef.current = focusedSectionId;
    const transition =
      prev === null && focusedSectionId !== null
        ? 'enter'
        : prev !== null && focusedSectionId === null
          ? 'exit'
          : null; // follow / no transition
    // A follow (id -> id') deliberately doesn't re-frame the map, and crucially
    // must NOT cancel a still-pending ENTER re-fit either: the entry timer reads
    // the latest focused id at fire time, so a quick follow during the settle
    // window still frames the section the user landed on instead of dropping the
    // zoom. So leave any pending timer untouched on a follow.
    if (transition === null) return;
    if (refitTimerRef.current !== null) window.clearTimeout(refitTimerRef.current);
    refitTimerRef.current = window.setTimeout(() => {
      refitTimerRef.current = null;
      setSource('sections-panel');
      const id = focusedSectionIdRef.current;
      if (transition === 'enter' && id !== null) {
        triggerZoomToSection(id);
      } else {
        triggerFitToBounds();
      }
    }, SECTION_FOCUS_REFIT_DELAY_MS);
  }, [focusedSectionId, triggerZoomToSection, triggerFitToBounds]);
  // The effect above no longer returns a per-change cleanup (so a follow can't
  // cancel an in-flight entry zoom); clear any pending re-fit on unmount instead.
  useEffect(
    () => () => {
      if (refitTimerRef.current !== null) window.clearTimeout(refitTimerRef.current);
    },
    [],
  );

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

  // Fullscreen data table: the overlay's top edge tracks the live toolbar
  // height (it can change with wrapping/zoom), published as a CSS var on the
  // root so the fixed-position wrapper can reference it. useLayoutEffect so the
  // var is set before the overlay's first paint.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const projectLoaded = project != null;
  useLayoutEffect(() => {
    if (!projectLoaded) return undefined;
    const root = rootRef.current;
    const toolbar = root?.querySelector<HTMLElement>('[data-testid="toolbar"]');
    if (!root || !toolbar) return undefined;
    const apply = () => root.style.setProperty('--toolbar-h', `${toolbar.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(toolbar);
    return () => ro.disconnect();
  }, [projectLoaded]);

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

  // Shared panel content (rendered in the reflow ResizablePanel when pinned, or
  // inside a PanelFloat overlay when hover-revealed). Dimmed during placement.
  const dimCls = placementModeActive ? 'pointer-events-none select-none opacity-45 grayscale' : '';
  const sectionsContent = (
    <div className={`h-full ${dimCls}`}>
      <ErrorBoundary panelName="Sections">
        <SectionsPanel sections={project.sections} />
      </ErrorBoundary>
    </div>
  );
  const detailContent = (
    <div className={`h-full ${dimCls}`}>
      <ErrorBoundary panelName="Details">
        <DetailPanel />
      </ErrorBoundary>
    </div>
  );
  const dataInner = (
    <div className={`h-full ${dimCls}`}>
      <ErrorBoundary panelName="Data Table">
        <DataTable sections={project.sections} />
      </ErrorBoundary>
    </div>
  );
  // Pinned data table supports fullscreen: the wrapper swaps to a fixed overlay
  // below the toolbar. The parent chain stays identical so the DataTable instance
  // (grid selection, scroll, view state) survives entering/exiting fullscreen.
  const dataPinnedContent = (
    <div
      className={dataTableFullScreen ? 'fixed inset-x-0 bottom-0 z-40 bg-panel' : 'relative h-full'}
      style={dataTableFullScreen ? { top: 'var(--toolbar-h, 48px)' } : undefined}
    >
      {dataInner}
    </div>
  );

  const panelName = {
    sections: t('singleView.panels.sectionsName'),
    detail: t('singleView.panels.detailName'),
    data: t('singleView.panels.dataName'),
  };
  const tabLabels = (name: string) => ({
    open: t('singleView.panels.open', { name }),
    pin: t('singleView.panels.pin'),
    unpin: t('singleView.panels.unpin'),
    close: t('singleView.panels.close', { name }),
  });

  return (
    <div ref={rootRef} className="h-full flex flex-col" data-testid="single-system-view">
      {/* Page heading for screen readers. The toolbar center now shows the
          active tool name (#51), so the project/focused-section name — the real
          page heading — lives here, visually hidden but still in the heading
          outline (follows the focused section in focus mode, per #50). */}
      <h1 className="sr-only" data-testid="page-heading">
        {focusedSectionName ?? project.name}
      </h1>
      {/* Toolbar */}
      <Toolbar
        menuItems={menuItems}
        onImport={handleImportDmpOrGpx}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        placementModeActive={placementModeActive}
        dataTableFullScreen={dataTableFullScreen}
      />

      {/* Main content */}
      <div className="relative flex-1 flex overflow-hidden">
        {/* Sections panel: reflow when pinned, else a thin full-edge opener bar */}
        {sectionsReveal.isPinnedOpen ? (
          <ResizablePanel
            direction="horizontal"
            defaultSize={sectionsPanelWidth}
            minSize={150}
            maxSize={400}
            onResize={setSectionsPanelWidth}
            onResizeEnd={(size) => savePanelSizes(size, undefined, undefined)}
            className="border-r border-border"
          >
            {sectionsContent}
          </ResizablePanel>
        ) : (
          <div
            className="w-3 flex-shrink-0 cursor-pointer border-r border-border bg-panel transition-colors hover:bg-background-80"
            onMouseEnter={sectionsReveal.onRegionEnter}
            onMouseLeave={sectionsReveal.onRegionLeave}
            onClick={sectionsReveal.openClick}
            role="button"
            tabIndex={0}
            aria-label={t('singleView.panels.open', { name: panelName.sections })}
            data-testid="sections-panel-bar"
          />
        )}

        {/* Map and data table */}
        <div className="relative flex-1 flex flex-col overflow-hidden">
          {/* Map */}
          <div className="flex-1 relative">
            <ErrorBoundary panelName="Map">
              <MapCanvas />
            </ErrorBoundary>
            {/* Offline indicator - positioned in top-right of map area */}
            <OfflineIndicator className="absolute top-2 right-14" />
          </div>

          {/* Data table: reflow when pinned, else a thin full-edge opener bar */}
          {dataReveal.isPinnedOpen ? (
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
              {dataPinnedContent}
            </ResizablePanel>
          ) : (
            <div
              className="h-3 shrink-0 cursor-pointer border-t border-border bg-panel transition-colors hover:bg-background-80"
              onMouseEnter={dataReveal.onRegionEnter}
              onMouseLeave={dataReveal.onRegionLeave}
              onClick={dataReveal.openClick}
              role="button"
              tabIndex={0}
              aria-label={t('singleView.panels.open', { name: panelName.data })}
              data-testid="data-table-bar"
            />
          )}

          {/* Data hover-overlay + opener tab (suppressed in fullscreen) */}
          {!dataTableFullScreen && (
            <>
              <PanelFloat edge="bottom" size={dataTableHeight} reveal={dataReveal}>
                {dataInner}
              </PanelFloat>
              <PanelOpenerTab
                reveal={dataReveal}
                edge="bottom"
                label={panelName.data}
                openArrow={<ChevronUpIcon size={14} />}
                closeArrow={<ChevronDownIcon size={14} />}
                style={{ right: 8, bottom: dataReveal.isOpen ? dataTableHeight : 0 }}
                testId="data"
                labels={tabLabels(panelName.data)}
              />
            </>
          )}
        </div>

        {/* Detail panel: reflow when pinned, else a thin full-edge opener bar */}
        {detailReveal.isPinnedOpen ? (
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
            {detailContent}
          </ResizablePanel>
        ) : (
          <div
            className="w-3 flex-shrink-0 cursor-pointer border-l border-border bg-panel transition-colors hover:bg-background-80"
            onMouseEnter={detailReveal.onRegionEnter}
            onMouseLeave={detailReveal.onRegionLeave}
            onClick={detailReveal.openClick}
            role="button"
            tabIndex={0}
            aria-label={t('singleView.panels.open', { name: panelName.detail })}
            data-testid="detail-panel-bar"
          />
        )}

        {/* Side hover-overlays (float over the map in hover mode) */}
        <PanelFloat edge="left" size={sectionsPanelWidth} reveal={sectionsReveal}>
          {sectionsContent}
        </PanelFloat>
        <PanelFloat edge="right" size={detailPanelWidth} reveal={detailReveal}>
          {detailContent}
        </PanelFloat>

        {/* Side opener tabs (near top; the detail tab clears the +/- zoom stack) */}
        <PanelOpenerTab
          reveal={sectionsReveal}
          edge="left"
          label={panelName.sections}
          openArrow={<ChevronRightIcon size={14} />}
          closeArrow={<ChevronLeftIcon size={14} />}
          style={{ left: 0, top: 72 }}
          testId="sections"
          labels={tabLabels(panelName.sections)}
        />
        <PanelOpenerTab
          reveal={detailReveal}
          edge="right"
          label={panelName.detail}
          openArrow={<ChevronLeftIcon size={14} />}
          closeArrow={<ChevronRightIcon size={14} />}
          style={{ right: 0, top: 72 }}
          testId="detail"
          labels={tabLabels(panelName.detail)}
        />
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
