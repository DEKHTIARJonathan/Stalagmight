import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useProject } from '../../hooks/useProject';
import { useAutoSave, type AutoSaveStatus } from '../../hooks/useAutoSave';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import type { SectionId } from '../../types/project';
import { useShallow } from 'zustand/react/shallow';
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
import { Dock, BAR } from './Dock';
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
  const saveFailed = autoSave.status === 'error';
  // Red wash in the status bar's bottom-right corner only when a save failed —
  // spans the full bar height and fades right→left across ~18% of its width.
  const statusBarGradient = saveFailed
    ? 'linear-gradient(to left, rgba(248, 113, 113, 0.30), transparent 18%)'
    : undefined;
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
  const menuItems = useProjectMenuItems({ onSave: handleSaveProject, saveFailed });

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

  // The Data panel's overlay is portaled to this Main element so it can span the
  // full width (past the center column's side insets). It stops at a pinned-open
  // side panel's edge; otherwise it fills to the window edge when the Data panel
  // is open (covering the gap left by a compressed side bar), or sits between the
  // closed bars (BAR inset) when the Data panel is itself closed.
  const [mainEl, setMainEl] = useState<HTMLDivElement | null>(null);
  // Resize-drag flags so each panel's edge that follows a sibling can track it
  // live (no transition lag): the side bars follow the Data panel's height, and
  // the Data overlay's left/right follow the side panels' widths.
  const [dataResizing, setDataResizing] = useState(false);
  const [sectionsResizing, setSectionsResizing] = useState(false);
  const [detailResizing, setDetailResizing] = useState(false);
  const sidePanelResizing = sectionsResizing || detailResizing;
  // Stop the Data overlay at ANY open side panel's edge — pinned OR hover-floating
  // (both render the full panel at its persisted width); only fill to the window
  // edge when the side is minimized and the Data panel is open, else sit between
  // the closed bars. (isOpen, not isPinnedOpen, or a floating side panel overlaps
  // the Data panel and hides its tab.)
  const dataOverlayLeft = sectionsReveal.isOpen
    ? sectionsPanelWidth
    : dataReveal.isOpen
      ? 0
      : BAR;
  const dataOverlayRight = detailReveal.isOpen
    ? detailPanelWidth
    : dataReveal.isOpen
      ? 0
      : BAR;

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

  // Shared panel content — each rendered in exactly ONE place (its Dock), so the
  // heavy instance is never duplicated/remounted across pin/unpin/hover. Dimmed
  // during placement (dim wraps content only, never the tab/handle).
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
        saveFailed={saveFailed}
        onImport={handleImportDmpOrGpx}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        placementModeActive={placementModeActive}
        dataTableFullScreen={dataTableFullScreen}
      />

      {/* Main content — the `relative` here is the positioning context for the
          side Docks' overlays + tabs. Each Dock renders a flow spacer (the only
          thing that reflows the map) plus a single absolute panel instance. */}
      <div ref={setMainEl} className="relative flex-1 flex overflow-hidden">
        {/* Sections (left) */}
        <Dock
          reveal={sectionsReveal}
          edge="left"
          size={sectionsPanelWidth}
          minSize={150}
          maxSize={400}
          onResize={setSectionsPanelWidth}
          onResizeEnd={(size) => savePanelSizes(size, undefined, undefined)}
          label={panelName.sections}
          openArrow={<ChevronRightIcon size={14} />}
          closeArrow={<ChevronLeftIcon size={14} />}
          testId="sections"
          tabLabels={tabLabels(panelName.sections)}
          // Just below the top-left "Fit to view" button (bottom ≈ 32px).
          tabTop={40}
          // When the Data panel is open (pinned OR hover-floating), compress this
          // bar (if minimized) so it stops at the Data panel's top instead of
          // running alongside it.
          closedBottomInset={dataReveal.isOpen ? dataTableHeight : 0}
          suspendSiblingTransition={dataResizing}
          onResizingChange={setSectionsResizing}
        >
          {sectionsContent}
        </Dock>

        {/* Map + data table. `min-w-0` lets this column shrink when both side
            panels dock (otherwise flex refuses and push behavior breaks). */}
        <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden">
          <div className="flex-1 relative">
            <ErrorBoundary panelName="Map">
              <MapCanvas />
            </ErrorBoundary>
            {/* Offline indicator - positioned in top-right of map area */}
            <OfflineIndicator className="absolute top-2 right-14 z-10" />
          </div>

          {/* Data (bottom) — inside the center column so docked side panels push
              it (and its tab) for free. Fullscreen renders without reparenting. */}
          <Dock
            reveal={dataReveal}
            edge="bottom"
            size={dataTableHeight}
            minSize={DATA_TABLE_MIN_HEIGHT}
            maxSize={DATA_TABLE_MAX_HEIGHT}
            onResize={setDataTableHeight}
            // Don't persist the temporary focus-mode height (#50): exit restores
            // the prior height only in memory, so a focus-time drag must not leak.
            onResizeEnd={(size) => {
              if (focusedSectionId === null) savePanelSizes(undefined, undefined, size);
            }}
            label={panelName.data}
            openArrow={<ChevronUpIcon size={14} />}
            closeArrow={<ChevronDownIcon size={14} />}
            testId="data"
            tabLabels={tabLabels(panelName.data)}
            // Keep the Data tab clear of the Details tab on the right (it can
            // ride up to the same height when the Data panel is tall).
            tabInset={40}
            fullscreen={dataTableFullScreen}
            // Portal the overlay to Main so it can span the full width (the
            // reflow spacer stays in the center column to push the map up).
            overlayContainer={mainEl}
            overlayLeft={dataOverlayLeft}
            overlayRight={dataOverlayRight}
            onResizingChange={setDataResizing}
            suspendSiblingTransition={sidePanelResizing}
          >
            {dataInner}
          </Dock>
        </div>

        {/* Details (right) */}
        <Dock
          reveal={detailReveal}
          edge="right"
          size={detailPanelWidth}
          minSize={200}
          maxSize={500}
          onResize={setDetailPanelWidth}
          onResizeEnd={(size) => savePanelSizes(undefined, size, undefined)}
          label={panelName.detail}
          openArrow={<ChevronLeftIcon size={14} />}
          closeArrow={<ChevronRightIcon size={14} />}
          testId="detail"
          tabLabels={tabLabels(panelName.detail)}
          tabTop={79}
          closedBottomInset={dataReveal.isOpen ? dataTableHeight : 0}
          suspendSiblingTransition={dataResizing}
          onResizingChange={setDetailResizing}
        >
          {detailContent}
        </Dock>
      </div>

      {/* Status bar. It sits just below the Data panel, so treat it as part of
          the Data hover region: keep an already-open (hover) Data panel open
          while the pointer rests here, but don't open it from closed. */}
      <footer
        onMouseEnter={() => {
          if (dataReveal.isFloatingOpen) dataReveal.onRegionEnter();
        }}
        onMouseLeave={dataReveal.onRegionLeave}
        className="px-4 py-2 border-t border-border text-sm text-text-secondary flex justify-between"
        style={{ backgroundImage: statusBarGradient }}
      >
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
        <SaveStatus
          status={autoSave.status}
          countdown={autoSave.countdown}
          isDirty={isDirty}
          onSave={handleSaveProject}
        />
      </footer>
    </div>
  );
}

function SaveStatus({
  status,
  countdown,
  isDirty,
  onSave,
}: {
  status: AutoSaveStatus;
  countdown: number;
  isDirty: boolean;
  onSave: () => void;
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

  // On a failed save, the status doubles as a retry — clicking it runs the same
  // save as the burger-menu Save button.
  if (status === 'error') {
    return (
      <button
        type="button"
        data-testid="save-status"
        onClick={() => onSave()}
        title={t('common.actions.save')}
        className={`${className} cursor-pointer hover:underline`}
      >
        {text}
      </button>
    );
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
