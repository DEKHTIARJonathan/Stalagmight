import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useOnboardingStep } from '../../hooks/useOnboardingStep';
import { useProject } from '../../hooks/useProject';
import { useAutoSave, type AutoSaveStatus } from '../../hooks/useAutoSave';
import { useProjectStore } from '../../store/projectStore';
import { PANEL_FIELDS, useUIStore, type PanelId, type PanelMode } from '../../store/uiStore';
import type { SectionId } from '../../types/project';
import { useShallow } from 'zustand/react/shallow';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { OfflineIndicator } from '../common/OfflineIndicator';
import Toolbar from './Toolbar';
import SectionsPanel from './SectionsPanel';
import DetailPanel from './DetailPanel';
import { GasPlanPanel } from './GasPlanPanel';
import { PlanTablesPanel } from './PlanTablesPanel';
import { ExportPanel } from './ExportPanel';
import DataTable from './DataTable';
import MapCanvas from '../Map/MapCanvas';
import { PANEL_SIZE_BOUNDS, DETAIL_REVEAL_AUTOCLOSE_MS } from './layoutConstants';
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon } from '../common/icons';
import { usePanelReveal } from './usePanelReveal';
import { Dock, BAR } from './Dock';
import { dmpImportFilters } from '../../utils/fileDialogs';
import { pickAndRoute } from '../../utils/openOrImport';
import { useProjectMenuItems } from './useProjectMenuItems';
import { setSource, withTrackingSuppressed, withPersistSuppressed, setProjectActionSource } from '../../utils/telemetry';
import { useTranslation } from 'react-i18next';
import { formatFixed, formatNumber } from '../../i18n/format';
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';

// #50: after double-click collapses the side panels, the map grows. fitToSection
// reads the container size at call time, so re-fit once the layout has reflowed
// and MapLibre's ResizeObserver has resized the map (a couple of frames). This
// lives here rather than in SectionsPanel, which unmounts when it collapses.
const SECTION_FOCUS_REFIT_DELAY_MS = 180;

// Top offsets (px) for the side opener tabs, aligning each tab with its panel's
// header/content divider. These track the panel header layout — revisit if the
// header height or the top-left map controls change. (The webview UI zoom scales
// these uniformly with the header, so they stay aligned under zoom.)
const SECTIONS_TAB_TOP = 40; // just below the top-left "Fit to view" button (bottom ≈ 32px)
const DETAILS_TAB_TOP = 79; // aligned to the Details panel's header/content divider

// Opener-tab arrow glyphs. Module-level constant elements (immutable, depend on
// nothing) so their identity is stable across renders — required for the memoized
// <Dock> to skip reconciliation during a sibling's resize drag (a fresh element
// each render would otherwise bust the memo every ~16ms).
const CHEVRON_RIGHT = <ChevronRightIcon size={14} />;
const CHEVRON_LEFT = <ChevronLeftIcon size={14} />;
const CHEVRON_UP = <ChevronUpIcon size={14} />;
const CHEVRON_DOWN = <ChevronDownIcon size={14} />;

export default function SingleSystemView() {
  const { t } = useTranslation();
  const precision = useDecimalPrecision();
  useKeyboardShortcuts();

  const {
    project,
    stats,
    handleSaveProject: rawSave,
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
  // Top-level workspace mode (#38, Daniel's reframe). Survey shows the editable data
  // table + detail panel; Plan swaps the right Dock for the gas setup sidebar and the
  // bottom Dock for the tabbed plan tables; Export swaps the right Dock for the export
  // stub and hides the bottom table. The carousel owns enter/exit; setView()/setColorMode
  // reset it. The left Sections Dock is survey-only (Plan/Export are read-only).
  const appMode = useUIStore((s) => s.appMode);

  // Depend on the stable cancelPending useCallback (not the whole autoSave object,
  // which is a fresh object each render) so handleSaveProject keeps a stable
  // identity — otherwise useProjectMenuItems' useMemo rebuilds the menu array on
  // every render (incl. ~60×/s during a resize drag).
  const cancelPending = autoSave.cancelPending;
  const handleSaveProject = useCallback(async (opts?: { closeAfterSave?: boolean }) => {
    cancelPending();
    return rawSave(opts);
  }, [cancelPending, rawSave]);

  // Toolbar "Import" button: DMP-only picker (the only format importable into an
  // open project; no "All Files" so non-importable types — notably a `.stalx`
  // project — can't be chosen and mis-routed), routed through the shared
  // open/import router. GPX/Ariane/Compass start new projects, so they aren't
  // offered here.
  const handleImportDmp = useCallback(async () => {
    setProjectActionSource('toolbar');
    await pickAndRoute(dmpImportFilters(), 'Import Failed');
  }, []);

  // Hamburger menu items (file/project actions). Built here so it can use the
  // autosave-aware wrapped save.
  const menuItems = useProjectMenuItems({ onSave: handleSaveProject, saveFailed });

  const {
    sectionsPanelWidth,
    detailPanelWidth,
    dataTableHeight,
    dataTableFullScreen,
    focusedSectionId,
    exitSectionFocus,
    setFocusedSection,
    selection,
    triggerZoomToSection,
    triggerFitToBounds,
    setSectionsPanelWidth,
    setDetailPanelWidth,
    setDataTableHeight,
    savePanelSizes,
  } = useUIStore(useShallow((s) => ({
    sectionsPanelWidth: s.sectionsPanelWidth,
    detailPanelWidth: s.detailPanelWidth,
    dataTableHeight: s.dataTableHeight,
    dataTableFullScreen: s.dataTableFullScreen,
    focusedSectionId: s.focusedSectionId,
    exitSectionFocus: s.exitSectionFocus,
    setFocusedSection: s.setFocusedSection,
    selection: s.selection,
    triggerZoomToSection: s.triggerZoomToSection,
    triggerFitToBounds: s.triggerFitToBounds,
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

  // Stable onResizeEnd handlers per Dock so handleProps identity stays stable
  // through a drag (these props feed useResizeHandle, which re-binds listeners
  // when they change). Inline arrows would be re-created every render — including
  // the ~60×/s store-width updates during the drag itself.
  const handleSectionsResizeEnd = useCallback(
    (size: number) => savePanelSizes('sections', size),
    [savePanelSizes],
  );
  const handleDetailResizeEnd = useCallback(
    (size: number) => savePanelSizes('detail', size),
    [savePanelSizes],
  );
  // Don't persist the temporary focus-mode height (#50): exit restores the prior
  // height only in memory, so a focus-time drag must not leak to config.
  const handleDataResizeEnd = useCallback(
    (size: number) => {
      if (focusedSectionId === null) savePanelSizes('data-table', size);
    },
    [savePanelSizes, focusedSectionId],
  );

  // Programmatic Details reveal (jump-to-warning from the data table). The store
  // bumps detailRevealNonce ONLY in hover mode (pin mode is revealed by opening
  // the panel in the store directly), so float it open like a hover and arm an
  // auto-close — the reveal isn't driven by a pointer over the panel, so without
  // this it could float open indefinitely. Lives here, not in usePanelReveal, so
  // only the Details panel carries the subscription (the others never need it).
  const detailRevealNonce = useUIStore((s) => s.detailRevealNonce);
  const detailRevealSeen = useRef(detailRevealNonce);
  const { onRegionEnter: revealDetail, scheduleClose: scheduleDetailClose } = detailReveal;
  useEffect(() => {
    if (detailRevealNonce === detailRevealSeen.current) return;
    detailRevealSeen.current = detailRevealNonce;
    revealDetail();
    scheduleDetailClose(DETAIL_REVEAL_AUTOCLOSE_MS);
  }, [detailRevealNonce, revealDetail, scheduleDetailClose]);

  // The Data panel's overlay is portaled to this Main element so it can span the
  // full width (past the center column's side insets). It stops at a pinned-open
  // side panel's edge; otherwise it fills to the window edge when the Data panel
  // is open (covering the gap left by a compressed side bar), or sits between the
  // closed bars (BAR inset) when the Data panel is itself closed.
  const [mainEl, setMainEl] = useState<HTMLDivElement | null>(null);
  // Which panel (if any) is being resized — at most one at a time, so a single
  // enum replaces three parallel booleans. Drives each panel's edge that follows a
  // sibling so it can track live (no transition lag): the side bars follow the Data
  // panel's height, and the Data overlay's left/right follow the side panels' widths.
  const [resizingPanel, setResizingPanel] = useState<PanelId | null>(null);
  // Stable per-panel callback for a Dock's onResizingChange. Clears only when the
  // panel that set the flag reports it ended, so a stray end-notification from a
  // different Dock can't wipe the active one. Stable identity (the Docks are
  // memoized) so it isn't re-created on the ~60×/s resize-tick re-renders.
  const setPanelResizing = useCallback(
    (panel: PanelId, resizing: boolean) =>
      setResizingPanel((prev) => (resizing ? panel : prev === panel ? null : prev)),
    [],
  );
  const onSectionsResizing = useCallback((r: boolean) => setPanelResizing('sections', r), [setPanelResizing]);
  const onDataResizing = useCallback((r: boolean) => setPanelResizing('data-table', r), [setPanelResizing]);
  const onDetailResizing = useCallback((r: boolean) => setPanelResizing('detail', r), [setPanelResizing]);
  const dataResizing = resizingPanel === 'data-table';
  const sidePanelResizing = resizingPanel === 'sections' || resizingPanel === 'detail';
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
  // Memoized: SingleSystemView re-renders ~60×/s during a panel-resize drag (it
  // subscribes to the panel width/height being mutated each tick), so the O(n)
  // .find() must not re-scan project.sections every frame when focus is active.
  const focusedSection = useMemo(
    () =>
      focusedSectionId !== null
        ? project?.sections.find((s) => s.id === focusedSectionId) ?? null
        : null,
    [focusedSectionId, project?.sections],
  );
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
    const statusBar = root?.querySelector<HTMLElement>('[data-testid="status-bar"]');
    if (!root || !toolbar) return undefined;
    // Expose the chrome heights so floating menus (e.g. data-table dropdowns) can
    // stay clear of the top toolbar and the bottom status bar when they flip.
    const apply = () => {
      root.style.setProperty('--toolbar-h', `${toolbar.offsetHeight}px`);
      if (statusBar) root.style.setProperty('--statusbar-h', `${statusBar.offsetHeight}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(toolbar);
    if (statusBar) ro.observe(statusBar);
    return () => ro.disconnect();
  }, [projectLoaded]);

  // Snapshot of a panel's persisted {mode, open} captured when onboarding forced
  // it open, so exiting the step restores the user's exact preference (including
  // hover mode) instead of leaving it pinned. Null when onboarding isn't holding it.
  type PanelSnapshot = { mode: PanelMode; open: boolean };
  const sectionsOnboardingSnapRef = useRef<PanelSnapshot | null>(null);
  const detailOnboardingSnapRef = useRef<PanelSnapshot | null>(null);
  const dataTableOnboardingSnapRef = useRef<PanelSnapshot | null>(null);

  // The active onboarding step (DOM-published by OnboardingOverlay), observed once
  // via the shared hook. Only this view's flow drives the panel reveals here.
  const onboarding = useOnboardingStep();
  const singleViewOnboardingStepId =
    onboarding.flowId === 'single-view-basics' ? onboarding.stepId : null;

  // Reveal the right panel during late SURVEY WORKSPACE steps (avoids a visible
  // tooltip jump when entering a panel step), without clobbering the user's
  // persisted panel mode: pin-open on entry, restore the snapshot on exit. Driven
  // by the observed step id, so it runs only when the step actually changes.
  useEffect(() => {
    // Onboarding's transient panel toggles must produce NO telemetry AND NO
    // config write (the user's saved layout must survive the temporary reveal),
    // so suppress both concerns together — withTrackingSuppressed gates telemetry
    // and withPersistSuppressed gates savePanelLayout's persist.
    const withOnboardingSuppressed = (fn: () => void) =>
      withTrackingSuppressed(() => withPersistSuppressed(fn));

    const syncOnboardingPanel = (
      panel: PanelId,
      shouldShow: boolean,
      snapRef: { current: PanelSnapshot | null },
    ) => {
      const ui = useUIStore.getState();
      const mode = ui[PANEL_FIELDS[panel].mode];
      const open = ui[PANEL_FIELDS[panel].open];
      const pinnedOpen = mode === 'pin' && open;

      if (shouldShow) {
        // Reveal it (pin-open) and remember the prior state — unless it's already
        // pinned-open, in which case there's nothing to reveal or restore.
        if (snapRef.current === null && !pinnedOpen) {
          snapRef.current = { mode, open };
          withOnboardingSuppressed(() => ui.setPanelMode(panel, 'pin'));
        }
      } else if (snapRef.current !== null) {
        const snap = snapRef.current;
        snapRef.current = null;
        // Only restore if the panel is still in the pinned-open state onboarding
        // forced it into. If the user changed it during the step (e.g. un-pinned or
        // closed it), that's a deliberate choice — honor it instead of reverting to
        // the pre-step snapshot.
        if (pinnedOpen) {
          withOnboardingSuppressed(() => {
            // setPanelMode forces open = (mode === 'pin'); fix up open if it differed
            // (e.g. the user had pinned-but-closed).
            ui.setPanelMode(panel, snap.mode);
            if (snap.open !== (snap.mode === 'pin')) ui.setPanelOpen(panel, snap.open);
          });
        }
      }
    };

    syncOnboardingPanel('sections', singleViewOnboardingStepId === 'sections', sectionsOnboardingSnapRef);
    syncOnboardingPanel('detail', singleViewOnboardingStepId === 'detail-panel', detailOnboardingSnapRef);
    syncOnboardingPanel('data-table', singleViewOnboardingStepId === 'data-table', dataTableOnboardingSnapRef);
  }, [singleViewOnboardingStepId]);

  // Shared panel content — each rendered in exactly ONE place (its Dock), so the
  // heavy instance is never duplicated/remounted across pin/unpin/hover. Memoized
  // so a panel-resize re-render (which fires ~60×/s as the store width/height
  // updates during a drag) doesn't reconcile the heavy DataTable / Sections /
  // Details subtrees: the Docks receive the SAME element reference and React bails
  // out of the child render. Dimmed during placement (dim wraps content only,
  // never the tab/handle).
  // NOTE: the `grayscale` filter establishes a containing block for
  // `position:fixed` descendants — which would re-trap the data-table sub-header
  // dropdowns inside the Dock's clip box (the exact #162 bug). It is safe ONLY
  // because the same wrapper is `pointer-events-none`, so those triggers can't be
  // clicked to open a dropdown while the filter is live. Keep `grayscale` paired
  // with `pointer-events-none` (or move the dim to an overlay) — don't dim the
  // panel subtree with a filter while leaving it interactive.
  const dimCls = placementModeActive ? 'pointer-events-none select-none opacity-45 grayscale' : '';
  const sections = project?.sections;
  const sectionsContent = useMemo(
    () =>
      sections ? (
        <div className={`h-full ${dimCls}`}>
          <ErrorBoundary panelName="Sections">
            <SectionsPanel sections={sections} />
          </ErrorBoundary>
        </div>
      ) : null,
    [sections, dimCls],
  );
  const detailContent = useMemo(
    () => (
      <div
        className={`h-full ${dimCls}`}
        // A programmatic hover-mode reveal (jump-to-warning) arms a timed auto-close
        // that otherwise only cancels on pointer-enter. Treat keyboard focus / typing
        // inside the panel as engagement too (onRegionEnter clears the grace), so a
        // keyboard-only user resolving a warning doesn't have it close mid-task.
        onFocusCapture={revealDetail}
        onKeyDownCapture={revealDetail}
      >
        <ErrorBoundary panelName="Details">
          {appMode === 'plan' ? (
            <GasPlanPanel />
          ) : appMode === 'export' ? (
            <ExportPanel />
          ) : (
            <DetailPanel />
          )}
        </ErrorBoundary>
      </div>
    ),
    [dimCls, revealDetail, appMode],
  );
  const dataInner = useMemo(
    () =>
      appMode === 'plan' ? (
        <div className="h-full">
          <ErrorBoundary panelName="Plan Tables">
            <PlanTablesPanel />
          </ErrorBoundary>
        </div>
      ) : sections ? (
        <div className={`h-full ${dimCls}`}>
          <ErrorBoundary panelName="Data Table">
            <DataTable sections={sections} />
          </ErrorBoundary>
        </div>
      ) : null,
    [appMode, sections, dimCls],
  );

  // Memoized on `t` (changes only on locale switch): each Dock's `label` and
  // `tabLabels` props must keep a stable identity so the memoized <Dock> can skip
  // reconciliation during a sibling's resize drag — a fresh object per render
  // would bust the memo every tick.
  const panelLabels = useMemo(() => {
    const name = {
      sections: t('singleView.panels.sectionsName'),
      detail: t('singleView.panels.detailName'),
      data: t('singleView.panels.dataName'),
    };
    const labels = (n: string) => ({
      open: t('singleView.panels.open', { name: n }),
      pin: t('singleView.panels.pin'),
      unpin: t('singleView.panels.unpin'),
      close: t('singleView.panels.close', { name: n }),
    });
    return {
      name,
      sections: labels(name.sections),
      detail: labels(name.detail),
      data: labels(name.data),
    };
  }, [t]);

  if (!project) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-text-secondary">{t('singleView.empty')}</div>
      </div>
    );
  }

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
        onImport={handleImportDmp}
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
        {/* Sections (left) — survey-only; Plan/Export show the read-only closure map
            with no section-editing affordances. */}
        {appMode === 'survey' && (
        <Dock
          reveal={sectionsReveal}
          edge="left"
          size={sectionsPanelWidth}
          minSize={PANEL_SIZE_BOUNDS.sections.min}
          maxSize={PANEL_SIZE_BOUNDS.sections.max}
          onResize={setSectionsPanelWidth}
          onResizeEnd={handleSectionsResizeEnd}
          label={panelLabels.name.sections}
          openArrow={CHEVRON_RIGHT}
          closeArrow={CHEVRON_LEFT}
          testId="sections"
          tabLabels={panelLabels.sections}
          tabTop={SECTIONS_TAB_TOP}
          // When the Data panel is open (pinned OR hover-floating), compress this
          // bar (if minimized) so it stops at the Data panel's top instead of
          // running alongside it.
          closedBottomInset={dataReveal.isOpen ? dataTableHeight : 0}
          suspendSiblingTransition={dataResizing}
          onResizingChange={onSectionsResizing}
        >
          {sectionsContent}
        </Dock>
        )}

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
              it (and its tab) for free. Fullscreen renders without reparenting. In
              Plan mode it holds the tabbed plan tables; Export hides it (map only). */}
          {appMode !== 'export' && (
          <Dock
            reveal={dataReveal}
            edge="bottom"
            size={dataTableHeight}
            minSize={PANEL_SIZE_BOUNDS['data-table'].min}
            maxSize={PANEL_SIZE_BOUNDS['data-table'].max}
            onResize={setDataTableHeight}
            onResizeEnd={handleDataResizeEnd}
            label={panelLabels.name.data}
            openArrow={CHEVRON_UP}
            closeArrow={CHEVRON_DOWN}
            testId="data"
            tabLabels={panelLabels.data}
            // Keep the Data tab clear of the Details tab on the right (it can
            // ride up to the same height when the Data panel is tall).
            tabInset={40}
            fullscreen={dataTableFullScreen}
            // Portal the overlay to Main so it can span the full width (the
            // reflow spacer stays in the center column to push the map up).
            overlayContainer={mainEl}
            overlayLeft={dataOverlayLeft}
            overlayRight={dataOverlayRight}
            onResizingChange={onDataResizing}
            suspendSiblingTransition={sidePanelResizing}
          >
            {dataInner}
          </Dock>
          )}
        </div>

        {/* Details (right) */}
        <Dock
          reveal={detailReveal}
          edge="right"
          size={detailPanelWidth}
          minSize={PANEL_SIZE_BOUNDS.detail.min}
          maxSize={PANEL_SIZE_BOUNDS.detail.max}
          onResize={setDetailPanelWidth}
          onResizeEnd={handleDetailResizeEnd}
          label={panelLabels.name.detail}
          openArrow={CHEVRON_LEFT}
          closeArrow={CHEVRON_RIGHT}
          testId="detail"
          tabLabels={panelLabels.detail}
          tabTop={DETAILS_TAB_TOP}
          closedBottomInset={dataReveal.isOpen ? dataTableHeight : 0}
          suspendSiblingTransition={dataResizing}
          onResizingChange={onDetailResizing}
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
        data-testid="status-bar"
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
