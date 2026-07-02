import { useEffect, useState, useCallback, useMemo, useRef, type MouseEvent, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useProject } from '../../hooks/useProject';
import { useGlobalViewShortcuts } from '../../hooks/useGlobalViewShortcuts';
import { useDismissableLayer } from '../../hooks/useDismissableLayer';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { useGlobalViewStore } from '../../store/globalViewStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { Button } from '../common/Button';
import { AppMenu, type AppMenuItem } from '../common/AppMenu';
import { leadingMenuItems, serviceMenuItems, quitMenuItem, importMenuItem, runImport, openFromSpeleoDbMenuItem } from '../common/appMenuItems';
import { CloseIcon, DownloadIcon, FilePlusIcon, FolderOpenIcon, ListIcon, MapIcon } from '../common/icons';
import { SpeleoBadgedIcon, RefreshGlyph } from '../common/SpeleoBadgedIcon';
import { syntacticLevelAtLeast } from '../../theme/syntacticPalette';
import { MENU_ICON_COLORS } from '../common/menuColors';
import { setProjectActionSource } from '../../utils/telemetry';
import { dmpOpenFilters, tmlOpenFilters, compassOpenFilters, wallsOpenFilters, gpxOpenFilters } from '../../utils/fileDialogs';
import { LoadingProgress } from '../LoadingProgress';
import SystemCard from './SystemCard';
import { resolveSpeleoLock } from './SpeleoLockBadge';
import GlobalViewMap, { type GlobalViewMapHandle } from './GlobalViewMap';
import MetadataPanel from './MetadataPanel';
import { RecentSortControl } from './RecentSortControl';
import { useRecentSort, sortRecentProjects, defaultDirectionForField, type RecentSortField } from './useRecentSort';
import { RecentDensityToggle } from './RecentDensityToggle';
import { useRecentDensity } from './useRecentDensity';
import SystemTable from './SystemTable';
import MissingSystemCard from './MissingSystemCard';
import {
  deriveMissingPaths,
  buildRecentListItems,
  filterRecentListItems,
} from './recentListItems';
import type { ProjectMetadata } from '../../types/project';
import { formatNumber } from '../../i18n/format';
import { debugLog } from '../../utils/debugLog';

/** Map phase enum values to human-readable labels */
function formatPhaseLabel(
  t: TFunction,
  phase: string | undefined,
  phaseIndex?: number,
  phaseCount?: number
): string {
  if (!phase) return t('globalView.loading.phases.initializing');

  const labels: Record<string, string> = {
    // Project opening phases
    opening_database: t('globalView.loading.phases.openingDatabase'),
    loading_project_data: t('globalView.loading.phases.loadingProjectData'),
    loading_sections: t('globalView.loading.phases.loadingSections'),
    computing_stations: t('globalView.loading.phases.computingStations'),
    computing_statistics: t('globalView.loading.phases.computingStatistics'),
    validating_data: t('globalView.loading.phases.validatingData'),
    loading_settings: t('globalView.loading.phases.loadingSettings'),
    finalizing: t('globalView.loading.phases.finalizing'),
    // Timeout message
    loading_taking_long: t('globalView.loading.phases.takingLong'),
    // Create project phases
    creating_database: t('globalView.loading.phases.creatingDatabase'),
    initializing_project: t('globalView.loading.phases.initializingProject'),
    saving_settings: t('globalView.loading.phases.savingSettings'),
  };

  const label = labels[phase] ?? phase;

  if (phaseIndex !== undefined && phaseCount !== undefined && phaseCount > 0) {
    return t('globalView.loading.step', { current: phaseIndex + 1, total: phaseCount, label });
  }

  return label;
}

type ViewTab = 'map' | 'list';

/**
 * Conservative upper bound on the OS double-click interval (Windows' max is
 * 500ms). In the list view we wait this long after a single click before showing
 * the details panel, so a double-click-to-open doesn't flash it — by the time it
 * elapses, the click was clearly a select (not the first half of an open).
 */
const DOUBLE_CLICK_MS = 500;

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  projectPath: string | null;
}

export default function GlobalView() {
  // [perf] Mark GlobalView mount + first effect so we can see when the
  // post-back UI is actually live (paired with [perf:close]).
  const _mountTimeRef = useRef(performance.now());
  useEffect(() => {
    const ms = performance.now() - _mountTimeRef.current;
    debugLog(`[perf:globalview-mount] firstEffect=${ms.toFixed(0)}ms after construction`);
    void import('../../utils/memoryProbe').then(({ recordPerfTiming }) => {
      recordPerfTiming('GlobalView mount', ms);
    });
  }, []);

  const {
    recentProjects,
    handleNewProject,
    handleOpenProject,
    handleOpenOrImport,
  } = useProject();

  const { loading, loadRecentProjects, loadProject, resetLoading, cancelLoading, removeFromRecentProjects, config } = useProjectStore();

  // Note: useLoadingProgress() is called in App.tsx (always mounted) to avoid duplicate listeners
  const { openDialog } = useUIStore();
  const syntacticLevel = useUIStore((s) => s.syntacticLevel);
  // Toolbar buttons show icons at the 'toolbar_only' level and up (menu items
  // use the stricter 'icons' level — handled inside AppMenu).
  const showToolbarIcons = syntacticLevelAtLeast(syntacticLevel, 'toolbar_only');
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ViewTab>('list');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
  const [metadataPanelCollapsed, setMetadataPanelCollapsed] = useState(false);
  // Search filter state (owned here, passed down to GlobalViewMap)
  const [searchTerm, setSearchTerm] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Ref to GlobalViewMap for spatial navigation
  const mapRef = useRef<GlobalViewMapHandle>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    projectPath: null,
  });
  const contextMenuRef = useRef<HTMLDivElement>(null);
  // State for zoom to system trigger (used by context menu "Zoom to System" action)
  const [zoomToSystem, setZoomToSystem] = useState<string | null>(null);

  useEffect(() => {
    loadRecentProjects();
  }, [loadRecentProjects]);

  // #201 (B1): the home screen is the app-open landing, so scan SpeleoDB lock state
  // here - one GET resolves every accessible project's holder. Populates the recents
  // lock badges and, if this user holds any locks, raises the resume/release prompt
  // (App owns the once-per-session guard). Best-effort + a no-op when logged out.
  const scanLocksOnOpen = useSpeleoStore((s) => s.scanLocksOnOpen);
  const remoteLocks = useSpeleoStore((s) => s.remoteLocks);
  const remoteProjects = useSpeleoStore((s) => s.remoteProjects);
  const speleoEmail = useSpeleoStore((s) => s.session?.userEmail ?? null);
  const speleoLoggedIn = useSpeleoStore((s) => s.session?.loggedIn ?? false);
  useEffect(() => {
    void scanLocksOnOpen();
  }, [scanLocksOnOpen]);

  // Manual SpeleoDB re-scan (the header refresh button, #201): re-reads lock state
  // for the recents badges. `prompt`-less, so it never re-raises the held-lock
  // dialog (that is reserved for login / app-open).
  const [refreshingLocks, setRefreshingLocks] = useState(false);
  const handleRefreshLocks = useCallback(async () => {
    setRefreshingLocks(true);
    try {
      await scanLocksOnOpen();
    } finally {
      setRefreshingLocks(false);
    }
  }, [scanLocksOnOpen]);

  // Close on outside mousedown / external scroll / resize (shared hook, same as
  // Select/AppMenu). Escape is handled in the global-view keyboard handler.
  useDismissableLayer({
    open: contextMenu.visible,
    onDismiss: () => setContextMenu((prev) => ({ ...prev, visible: false })),
    contains: [contextMenuRef],
  });

  // Note: Context menu escape is handled in the main keyboard handler below

  // Access global view store for lazy loading and selection
  const { geometryData, geometryStates, selectedSystemIds } = useGlobalViewStore();

  // Sync store selection to local state when map Ctrl+click changes store
  // This ensures keyboard shortcuts work with map multi-selection
  useEffect(() => {
    // Only sync when there's an actual change to avoid loops
    const storeSet = selectedSystemIds;
    const localSet = multiSelectedIds;

    // Check if sets are different
    const areDifferent = storeSet.size !== localSet.size ||
      [...storeSet].some(id => !localSet.has(id));

    if (areDifferent) {
      setMultiSelectedIds(new Set(storeSet));
      // Update primary selection based on store
      if (storeSet.size === 0) {
        // Store cleared - clear primary selection too
        setSelectedProjectId(null);
      } else if (!storeSet.has(selectedProjectId ?? '')) {
        // Primary selection not in store - update to first in store
        const firstId = [...storeSet][0];
        if (firstId) {
          setSelectedProjectId(firstId);
        }
      }
    }
  }, [selectedSystemIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Check if there are any GPS-positioned projects (null check only, no sentinel)
  const gpsProjectCount = useMemo(
    () => recentProjects.filter((p) => p.gps_center !== null).length,
    [recentProjects]
  );
  const hasGpsProjects = gpsProjectCount > 0;

  // Handle project selection (single click)
  const handleProjectSelect = useCallback((filePath: string, ctrlKey?: boolean) => {
    if (ctrlKey) {
      // Ctrl+click: toggle selection in multi-select mode. The SET is committed
      // through a pure functional updater so two clicks in one React batch can't
      // each read a stale `multiSelectedIds` and drop the other's change.
      const wasSelected = multiSelectedIds.has(filePath);
      setMultiSelectedIds((prev) => {
        const newSet = new Set(prev);
        if (newSet.has(filePath)) {
          newSet.delete(filePath);
        } else {
          newSet.add(filePath);
        }
        return newSet;
      });
      // Primary selection for the metadata panel — kept OUT of the updater above
      // so that updater stays pure (no setState side-effect; clean under
      // StrictMode's double-invoke). On an ADD, the clicked project becomes
      // primary; on a DESELECT, promote the last surviving member (or clear).
      // Derived from the pre-click set; a same-batch double-click would only skew
      // the primary pointer, which self-heals on the next selection sync.
      if (wasSelected) {
        const survivors = [...multiSelectedIds].filter((id) => id !== filePath);
        setSelectedProjectId(survivors.length > 0 ? survivors[survivors.length - 1]! : null);
      } else {
        setSelectedProjectId(filePath);
      }
    } else {
      // Regular click: single select, clear multi-select
      setSelectedProjectId(filePath);
      setMultiSelectedIds(new Set([filePath]));
    }
  }, [multiSelectedIds]);

  // Handle right-click context menu (from list view)
  const handleContextMenu = useCallback((e: MouseEvent, filePath: string) => {
    e.preventDefault();
    // If right-clicked project isn't selected, select it
    if (!multiSelectedIds.has(filePath)) {
      setSelectedProjectId(filePath);
      setMultiSelectedIds(new Set([filePath]));
    }
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      projectPath: filePath,
    });
  }, [multiSelectedIds]);

  // Handle context menu from map (called with coordinates instead of MouseEvent)
  const handleMapContextMenu = useCallback((filePath: string, x: number, y: number) => {
    // If right-clicked project isn't selected, select it
    if (!multiSelectedIds.has(filePath)) {
      setSelectedProjectId(filePath);
      setMultiSelectedIds(new Set([filePath]));
    }
    setContextMenu({
      visible: true,
      x,
      y,
      projectPath: filePath,
    });
  }, [multiSelectedIds]);

  // Handle project open (double-click on map or from metadata panel)
  const handleProjectOpen = useCallback(async (filePath: string) => {
    // loadProject handles view switching and clears GlobalView geometry cache
    await loadProject(filePath);
  }, [loadProject]);

  // Source-tagged open variants for telemetry attribution (the recent list vs
  // the recent map are distinct entry points feeding the same loadProject).
  const handleOpenFromList = useCallback((filePath: string) => {
    setProjectActionSource('recent-list');
    return handleProjectOpen(filePath);
  }, [handleProjectOpen]);
  const handleOpenFromMap = useCallback((filePath: string) => {
    setProjectActionSource('recent-map');
    return handleProjectOpen(filePath);
  }, [handleProjectOpen]);

  // Handle cancel during loading
  const handleCancelLoading = useCallback(async () => {
    await cancelLoading();
  }, [cancelLoading]);

  // Handle retry after error
  const handleRetryLoading = useCallback(async () => {
    if (loading.projectPath) {
      // Retry of a recent-projects open; attribute it the same way.
      setProjectActionSource('recent-list');
      await loadProject(loading.projectPath);
    }
  }, [loading.projectPath, loadProject]);

  // Handle dismiss error (reset loading state)
  const handleDismissError = useCallback(() => {
    resetLoading();
  }, [resetLoading]);

  // Handle remove from recent (from metadata panel)
  const handleRemoveFromRecent = useCallback(async (filePath: string) => {
    await removeFromRecentProjects(filePath);
    // Clear selection if the removed project was selected
    if (selectedProjectId === filePath) {
      setSelectedProjectId(null);
    }
    // Remove from multi-selection
    setMultiSelectedIds((prev) => {
      const newSet = new Set(prev);
      newSet.delete(filePath);
      return newSet;
    });
  }, [removeFromRecentProjects, selectedProjectId]);

  // Prune selection when a project leaves the recents list (e.g. after a delete,
  // or any external removal): otherwise selectedProjectId / multiSelectedIds dangle
  // on a path that's gone, and Enter/Delete would act on it. The valid set is the
  // loaded recents plus config "missing" paths, so selecting a missing entry sticks.
  useEffect(() => {
    const valid = new Set<string>([
      ...recentProjects.map((p) => p.file_path),
      ...(config?.general?.recent_projects ?? []),
    ]);
    setSelectedProjectId((prev) => (prev && !valid.has(prev) ? null : prev));
    setMultiSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (valid.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
    // Also prune the map-selection store. The store→local sync effect above
    // copies selectedSystemIds back into multiSelectedIds on the next map
    // ctrl-click, so a deleted path left in the store gets resurrected into the
    // selection (status-bar count + Enter/Delete then point at a gone file).
    // Read fresh via getState() (not the render-closure value, which isn't a
    // dep here) and only write when something was actually removed.
    const gv = useGlobalViewStore.getState();
    const prunedSystems = new Set([...gv.selectedSystemIds].filter((id) => valid.has(id)));
    if (prunedSystems.size !== gv.selectedSystemIds.size) {
      gv.setSelectedSystems(prunedSystems);
    }
  }, [recentProjects, config]);

  // Register GlobalView keyboard shortcuts via hook
  useGlobalViewShortcuts({
    selectedProjectId,
    multiSelectedIds,
    activeTab,
    recentProjects,
    loading,
    contextMenu,
    mapRef,
    setSelectedProjectId,
    setMultiSelectedIds,
    setContextMenu,
    handleProjectOpen,
    handleRemoveFromRecent,
  });

  // Handle merge projects
  const handleMergeProjects = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
    const selectedProjects: ProjectMetadata[] = recentProjects.filter((p) =>
      multiSelectedIds.has(p.file_path)
    );
    if (selectedProjects.length >= 2) {
      openDialog('merge-projects', { selectedProjects });
    }
  }, [multiSelectedIds, recentProjects, openDialog]);

  // Switch between map and list views. Search is list-only, so clear the term
  // when entering the map (the map shows all projects unfiltered).
  const handleSwitchTab = useCallback((tab: ViewTab) => {
    setActiveTab(tab);
    if (tab === 'map') {
      setSearchTerm('');
    }
  }, []);

  // Handle zoom to system (context menu action)
  const handleZoomToSystem = useCallback(() => {
    if (contextMenu.projectPath) {
      // Toggle to map tab if not already there
      if (activeTab !== 'map') {
        handleSwitchTab('map');
      }
      // Trigger zoom - use a counter pattern to ensure re-trigger even for same path
      setZoomToSystem(contextMenu.projectPath);
    }
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, [contextMenu.projectPath, activeTab, handleSwitchTab]);

  // Callback for GlobalViewMap to signal zoom was handled
  const handleZoomHandled = useCallback(() => {
    setZoomToSystem(null);
  }, []);

  // Handle show in folder (context menu action)
  const handleShowInFolder = useCallback(async () => {
    if (contextMenu.projectPath) {
      try {
        await revealItemInDir(contextMenu.projectPath);
      } catch (err) {
        console.error('Failed to reveal in folder:', err);
      }
    }
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, [contextMenu.projectPath]);

  // Handle search input changes (instant filtering)
  const handleSearchChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value);
  }, []);

  // Handle clearing search (X button)
  const handleClearSearch = useCallback(() => {
    setSearchTerm('');
    searchInputRef.current?.focus();
  }, []);

  // Handle search input keyboard events (Escape to clear)
  const handleSearchKeyDown = useCallback((e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setSearchTerm('');
      // Keep focus on input after clearing
    }
  }, []);

  // Get the selected project metadata
  const selectedProject = useMemo(() => {
    if (!selectedProjectId) return null;
    return recentProjects.find(p => p.file_path === selectedProjectId) || null;
  }, [selectedProjectId, recentProjects]);

  // Selected projects array for multi-selection support. Declared before the
  // latch effect below so it can treat a surviving multi-selection as a live
  // selection — the MetadataPanel renders the aggregate from this array even when
  // there is no primary selectedProject.
  const selectedProjects = useMemo(() => {
    return recentProjects.filter(p => multiSelectedIds.has(p.file_path));
  }, [recentProjects, multiSelectedIds]);

  // Latch gating the list-view details panel. It starts hidden and opens only
  // once a selection is confirmed; while a selection holds it STAYS open —
  // switching between projects just updates its content (never re-hide/flicker
  // it). The first reveal is gated so a double-click-to-open doesn't flash it:
  // immediate in the map view (no open-vs-select ambiguity), and debounced by the
  // double-click window in the list view. Clears only when NOTHING is selected
  // (no primary AND no multi-selection survivors — e.g. the selected project was
  // removed/pruned) so the list view never strands the empty "Select a project"
  // panel and the next selection is debounced again. (Also resets when GlobalView
  // remounts, e.g. after returning from a project.)
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    if (!selectedProjectId && selectedProjects.length === 0) {
      setDetailsOpen(false); // nothing selected — re-hide and re-arm the debounce
      return;
    }
    if (detailsOpen) return; // already open — leave it; content follows the selection
    // Past here, something is selected (primary OR a surviving multi-selection),
    // so reveal the panel. A multi-selection with no primary (e.g. the prune
    // effect nulled the primary while other selections remain) still reveals —
    // the panel renders the aggregate from selectedProjects.
    if (activeTab === 'map') {
      setDetailsOpen(true);
      return;
    }
    const timer = window.setTimeout(() => setDetailsOpen(true), DOUBLE_CLICK_MS);
    return () => window.clearTimeout(timer);
  }, [selectedProjectId, selectedProjects.length, activeTab, detailsOpen]);

  // Get selected projects count
  const selectedCount = multiSelectedIds.size;

  // Recent-projects sort preference (persisted) and the sorted list for the
  // list view. The map view is intentionally unaffected by this.
  const recentSort = useRecentSort();
  const sortedProjects = useMemo(
    () => sortRecentProjects(recentProjects, recentSort.field, recentSort.direction),
    [recentProjects, recentSort.field, recentSort.direction]
  );

  // List view layout density (cards vs compact table), persisted.
  const [density, setDensity] = useRecentDensity();

  // Clicking a table column header sorts by it: toggle direction if already
  // active, otherwise switch fields with a sensible default direction.
  const handleHeaderSort = useCallback(
    (field: RecentSortField) => {
      if (recentSort.field === field) {
        recentSort.toggleDirection();
      } else {
        recentSort.setField(field);
        recentSort.setDirection(defaultDirectionForField(field));
      }
    },
    [recentSort]
  );

  // Recent paths the backend kept in config but couldn't load (file moved,
  // deleted, or unreadable) are surfaced as "unavailable" rows so the user can
  // see and remove them, rather than having them silently vanish.
  const recentPaths = config?.general.recent_projects ?? [];
  const missingPaths = useMemo(
    () => deriveMissingPaths(recentPaths, recentProjects),
    [recentPaths, recentProjects]
  );
  // Combined, then filtered by the search term (name / location / path).
  const listItems = useMemo(
    () => buildRecentListItems(sortedProjects, missingPaths),
    [sortedProjects, missingPaths]
  );
  const visibleItems = useMemo(
    () => filterRecentListItems(listItems, searchTerm),
    [listItems, searchTerm]
  );
  const isSearching = searchTerm.trim().length > 0;
  // Gate the tabs and content area on the combined count (loaded + missing) so
  // an all-missing recent list still renders its removable rows instead of the
  // EmptyState — otherwise the user can never clear those entries. (The metadata
  // panel stays gated on loaded projects, since missing rows aren't selectable.)
  const hasRecentItems = listItems.length > 0;

  // Hamburger menu contents. The New/Open/Settings/Debug/Quit rows are shared
  // with the in-project menu (appMenuItems); only the Import submenu differs
  // (the start screen offers every new-project format). Memoized so AppMenu's
  // items-dependent callbacks don't churn on every keystroke-driven re-render.
  const menuItems: AppMenuItem[] = useMemo(
    () => [
      ...leadingMenuItems(t, { onNewProject: handleNewProject, onOpenProject: handleOpenProject }, 'hamburger'),
      openFromSpeleoDbMenuItem(t, { onOpen: () => openDialog('open-from-speleodb') }),
      {
        id: 'global-import-menu-button',
        label: t('globalView.actions.import'),
        icon: <DownloadIcon size={18} />,
        iconColor: MENU_ICON_COLORS.import,
        // Route every format through the shared open/import router (like the
        // in-project Import submenu) so all import entry points behave identically.
        // No project is open here, so the broader format set is offered, each with
        // its own per-format picker filter (matching the legacy per-format handlers).
        submenu: [
          importMenuItem('global-import-dmp-button', t('globalView.actions.importDmp'), dmpOpenFilters, 'hamburger', 'import_dmp'),
          importMenuItem('global-import-tml-button', t('globalView.actions.importTml'), tmlOpenFilters, 'hamburger'),
          importMenuItem('global-import-compass-button', t('globalView.actions.importCompass'), compassOpenFilters, 'hamburger'),
          importMenuItem('global-import-walls-button', t('globalView.actions.importWalls'), wallsOpenFilters, 'hamburger'),
          importMenuItem('global-import-gpx-button', t('globalView.actions.importGpx'), gpxOpenFilters, 'hamburger'),
        ],
      },
      { id: 'app-menu-sep-1', label: '', separator: true },
      ...serviceMenuItems(t, { onSettings: () => openDialog('settings'), onDebug: () => openDialog('debug') }),
      { id: 'app-menu-sep-2', label: '', separator: true },
      quitMenuItem(t),
    ],
    [t, handleNewProject, handleOpenProject, openDialog],
  );

  return (
    <div data-testid="global-view" className="h-full flex flex-col">
      {/* Header — left: menu + primary actions, center: title, right: Map|List toggle */}
      <header className="grid grid-cols-[1fr_auto_1fr] items-center px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3 justify-self-start">
          <AppMenu items={menuItems} aria-label={t('globalView.menu.aria')} />
          <Button
            data-testid="new-project-button"
            onClick={() => { setProjectActionSource('toolbar'); handleNewProject(); }}
            icon={showToolbarIcons ? <span style={{ color: MENU_ICON_COLORS.new }}><FilePlusIcon size={16} /></span> : undefined}
          >
            {t('globalView.actions.newProject')}
          </Button>
          <Button
            data-testid="global-open-import-button"
            onClick={() => { setProjectActionSource('toolbar'); handleOpenOrImport(); }}
            icon={showToolbarIcons ? <span style={{ color: MENU_ICON_COLORS.open }}><FolderOpenIcon size={16} /></span> : undefined}
          >
            {t('globalView.actions.openOrImport')}
          </Button>
        </div>

        <h1 className="text-xl font-bold justify-self-center">Stalagmight</h1>

        <div className="flex items-center gap-2 justify-self-end">
          {hasRecentItems && (
            <div
              className="inline-flex rounded border border-border overflow-hidden"
              role="group"
              aria-label={t('globalView.viewToggle.aria')}
            >
              <button
                type="button"
                aria-pressed={activeTab === 'map'}
                data-testid="globalview-view-toggle-map"
                onClick={() => handleSwitchTab('map')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium transition-colors ${
                  activeTab === 'map'
                    ? 'bg-accent text-accent-on'
                    : 'text-text-secondary hover:text-text hover:bg-panel'
                }`}
              >
                {showToolbarIcons && <MapIcon size={16} />}
                {t('globalView.tabs.map')}
                {hasGpsProjects ? ` (${formatNumber(gpsProjectCount)})` : ''}
              </button>
              <button
                type="button"
                aria-pressed={activeTab === 'list'}
                data-testid="globalview-view-toggle-list"
                onClick={() => handleSwitchTab('list')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border-l border-border transition-colors ${
                  activeTab === 'list'
                    ? 'bg-accent text-accent-on'
                    : 'text-text-secondary hover:text-text hover:bg-panel'
                }`}
              >
                {showToolbarIcons && <ListIcon size={16} />}
                {t('globalView.tabs.list')} ({formatNumber(recentProjects.length)})
              </button>
            </div>
          )}
          {/* SpeleoDB re-scan, far right of the view toggle - only when logged in
              (#201). Refreshes the recents lock badges without re-prompting. */}
          {speleoLoggedIn && (
            <button
              type="button"
              onClick={() => void handleRefreshLocks()}
              disabled={refreshingLocks}
              title={t('globalView.speleoRefresh.title')}
              aria-label={t('globalView.speleoRefresh.aria')}
              data-testid="globalview-speleo-refresh"
              className="flex items-center justify-center w-8 h-8 rounded text-text-secondary hover:text-text hover:bg-panel transition-colors disabled:opacity-50"
            >
              <SpeleoBadgedIcon badge={<RefreshGlyph size={10} />} badgeColor="text-accent" size={18} />
            </button>
          )}
        </div>
      </header>

      {/* Loading Modal Overlay */}
      {loading.isLoading && (
        <div className="fixed inset-0 bg-overlay flex items-center justify-center z-50">
          <LoadingProgress
            title={
              loading.error
                ? t('globalView.loading.failedTitle')
                : t('globalView.loading.loadingTitle', {
                  name: loading.projectName ?? t('globalView.loading.projectFallback'),
                })
            }
            phase={formatPhaseLabel(t, loading.phase, loading.phaseIndex, loading.phaseCount)}
            overallProgress={loading.overallProgress}
            onCancel={loading.error ? handleDismissError : handleCancelLoading}
            {...(loading.phaseProgress !== undefined && { phaseProgress: loading.phaseProgress })}
            {...(loading.phaseCurrent !== undefined && { phaseCurrent: loading.phaseCurrent })}
            {...(loading.phaseTotal !== undefined && { phaseTotal: loading.phaseTotal })}
            {...(loading.error ? { error: loading.error } : {})}
            {...(loading.error && loading.projectPath ? { onRetry: handleRetryLoading } : {})}
          />
        </div>
      )}

      {/* Content */}
      <main className="flex-1 overflow-hidden flex">
        {/* Main content area - disabled during loading */}
        <div className={`flex-1 overflow-hidden ${loading.isLoading ? 'pointer-events-none opacity-50' : ''}`}>
          {!hasRecentItems ? (
            <div className="h-full overflow-auto p-6">
              <EmptyState
                onImport={() => { runImport(dmpOpenFilters(), 'empty-state'); }}
                onNew={() => { setProjectActionSource('empty-state'); handleNewProject(); }}
                onOpen={() => { setProjectActionSource('empty-state'); handleOpenProject(); }}
              />
            </div>
          ) : activeTab === 'map' ? (
            // Search is list-only now; the map always shows all projects (searchTerm="").
            <GlobalViewMap
              ref={mapRef}
              projects={recentProjects}
              selectedProjectId={selectedProjectId}
              onProjectSelect={(path) => handleProjectSelect(path, false)}
              onProjectOpen={handleOpenFromMap}
              geometryData={geometryData}
              geometryStates={geometryStates}
              searchTerm=""
              onContextMenu={handleMapContextMenu}
              zoomToSystem={zoomToSystem}
              onZoomHandled={handleZoomHandled}
            />
          ) : (
            // Top padding lives on the inner content (not the scroll container) so
            // the table's sticky header pins flush to the top — container
            // padding-top would otherwise leave a gap the rows scroll through.
            <div className="h-full overflow-auto px-6 pb-6">
              <div className="flex items-center justify-between gap-4 mb-4 pt-6">
                <h2 className="text-lg font-medium">{t('globalView.recent.title')}</h2>
                <div className="flex items-center gap-3">
                  {selectedCount >= 2 && (
                    <Button
                      onClick={handleMergeProjects}
                      data-testid="merge-projects-button"
                      aria-label={t('globalView.actions.mergeProjectsAria', {
                        count: selectedCount,
                        countFormatted: formatNumber(selectedCount),
                      })}
                    >
                      {t('globalView.actions.mergeProjects', {
                        count: selectedCount,
                        countFormatted: formatNumber(selectedCount),
                      })}
                    </Button>
                  )}
                  <RecentSortControl
                    field={recentSort.field}
                    direction={recentSort.direction}
                    onFieldChange={recentSort.setField}
                    onToggleDirection={recentSort.toggleDirection}
                  />
                  <RecentDensityToggle density={density} onChange={setDensity} />
                </div>
              </div>
              <div className="flex items-start justify-between gap-4 mb-4" data-testid="globalview-list-status-row">
                <p className="text-xs text-text-secondary" data-testid="globalview-list-status">
                  {isSearching ? (
                    t('globalView.recent.countFiltered', {
                      shown: formatNumber(visibleItems.length),
                      total: formatNumber(listItems.length),
                    })
                  ) : (
                    <>
                      {t('globalView.recent.hintPrefix')}{' '}
                      {t('globalView.recent.hintFindPrefix')}{' '}
                      <button
                        type="button"
                        onClick={() => { setProjectActionSource('recent-list'); handleOpenOrImport(); }}
                        className="text-accent hover:underline"
                        data-testid="globalview-hint-open-link"
                      >
                        {t('globalView.recent.hintFindLink')}
                      </button>
                      {t('globalView.recent.hintFindSuffix')}
                    </>
                  )}
                </p>

                {/* Search — list-only; the map shows all projects. */}
                <div className="relative shrink-0">
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchTerm}
                    onChange={handleSearchChange}
                    onKeyDown={handleSearchKeyDown}
                    placeholder={t('globalView.search.placeholder')}
                    className="bg-panel border border-border rounded px-2 py-1 text-sm w-48 pr-7 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    data-testid="globalview-search-input"
                    aria-label={t('globalView.search.aria')}
                  />
                  {searchTerm && (
                    <button
                      onClick={handleClearSearch}
                      className="absolute right-1 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text p-1"
                      title={t('globalView.search.clearTitle')}
                      aria-label={t('globalView.search.clearAria')}
                      data-testid="globalview-search-clear"
                    >
                      <CloseIcon size={14} />
                    </button>
                  )}
                </div>
              </div>

              {visibleItems.length === 0 ? (
                <div
                  className="flex flex-col items-center justify-center text-center py-16 text-text-secondary"
                  data-testid="globalview-list-empty"
                >
                  <p className="text-sm mb-2">
                    {t('globalView.recent.noResults', { term: searchTerm })}
                  </p>
                  <button
                    type="button"
                    onClick={handleClearSearch}
                    className="text-sm text-accent hover:underline"
                    data-testid="globalview-list-clear-search"
                  >
                    {t('globalView.search.clearTitle')}
                  </button>
                </div>
              ) : density === 'table' ? (
                <SystemTable
                  items={visibleItems}
                  selectedProjectId={selectedProjectId}
                  multiSelectedIds={multiSelectedIds}
                  sortField={recentSort.field}
                  sortDirection={recentSort.direction}
                  remoteLocks={remoteLocks}
                  remoteProjects={remoteProjects}
                  myEmail={speleoEmail}
                  onSort={handleHeaderSort}
                  onSelect={handleProjectSelect}
                  onOpen={handleOpenFromList}
                  onContextMenu={handleContextMenu}
                  onRemoveMissing={handleRemoveFromRecent}
                />
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {visibleItems.map((item) =>
                    item.kind === 'available' ? (
                      <SystemCard
                        key={item.filePath}
                        name={item.project.name}
                        location={item.project.location}
                        filePath={item.filePath}
                        modifiedAt={item.project.modified_at}
                        sectionCount={item.project.section_count}
                        totalLength={item.project.total_length}
                        isSelected={multiSelectedIds.has(item.filePath)}
                        speleoLock={resolveSpeleoLock(item.project, remoteLocks, speleoEmail, remoteProjects)}
                        onSelect={(ctrlKey) => handleProjectSelect(item.filePath, ctrlKey)}
                        onContextMenu={(e) => handleContextMenu(e, item.filePath)}
                      />
                    ) : (
                      <MissingSystemCard
                        key={item.filePath}
                        name={item.name}
                        filePath={item.filePath}
                        onRemove={handleRemoveFromRecent}
                      />
                    )
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Metadata Panel. Map view: always shown (lives alongside the map), incl.
            the empty "Select a project" state. List view: hidden until the first
            selection is confirmed past the double-click window (so it doesn't flash
            on a double-click-to-open), then it follows the selection — and requires
            a live selection (primary OR a surviving multi-selection), so it never
            shows the empty state in the list. */}
        {recentProjects.length > 0 && (activeTab === 'map' || (detailsOpen && (selectedProject !== null || selectedProjects.length > 0))) && (
          <MetadataPanel
            project={selectedProject}
            selectedProjects={selectedProjects}
            onOpenProject={handleOpenFromList}
            onRemoveFromRecent={handleRemoveFromRecent}
            collapsed={metadataPanelCollapsed}
            onCollapseChange={setMetadataPanelCollapsed}
          />
        )}
      </main>

      {/* Status bar */}
      <footer className="px-4 py-2 border-t border-border text-sm text-text-secondary flex justify-between">
        <span>
          {t('globalView.status.systems', {
            count: recentProjects.length,
            countFormatted: formatNumber(recentProjects.length),
          })}
          {selectedCount > 1 && ` | ${t('globalView.status.selected', {
            count: selectedCount,
            countFormatted: formatNumber(selectedCount),
          })}`}
        </span>
        <span>{t('globalView.status.ready')}</span>
      </footer>

      {/* Context Menu */}
      {contextMenu.visible && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-panel border border-border rounded-lg shadow-xl py-1 min-w-[180px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          aria-label={t('globalView.contextMenu.aria')}
          data-testid="project-context-menu"
        >
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-background-50 flex items-center gap-2"
            onClick={() => {
              if (contextMenu.projectPath) {
                setProjectActionSource('context-menu');
                handleProjectOpen(contextMenu.projectPath);
              }
              setContextMenu((prev) => ({ ...prev, visible: false }));
            }}
            role="menuitem"
            data-testid="context-menu-open"
          >
            {t('globalView.contextMenu.open')}
          </button>
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-background-50 flex items-center gap-2"
            onClick={handleZoomToSystem}
            role="menuitem"
            data-testid="context-menu-zoom"
          >
            {t('globalView.contextMenu.zoom')}
          </button>
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-background-50 flex items-center gap-2"
            onClick={handleShowInFolder}
            role="menuitem"
            data-testid="context-menu-show-in-folder"
          >
            {t('globalView.contextMenu.showInFolder')}
          </button>
          {selectedCount >= 2 && (
            <button
              className="w-full px-4 py-2 text-left text-sm hover:bg-background-50 flex items-center gap-2"
              onClick={handleMergeProjects}
              role="menuitem"
              data-testid="context-menu-merge"
            >
              {t('globalView.contextMenu.mergeProjects', {
                count: selectedCount,
                countFormatted: formatNumber(selectedCount),
              })}
            </button>
          )}
          <div className="border-t border-border my-1" />
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-background-50 flex items-center gap-2"
            onClick={async () => {
              // Handle multi-selection remove with count
              try {
                if (selectedCount > 1) {
                  // Remove all selected projects sequentially
                  for (const id of multiSelectedIds) {
                    await handleRemoveFromRecent(id);
                  }
                } else if (contextMenu.projectPath) {
                  await handleRemoveFromRecent(contextMenu.projectPath);
                }
              } catch (err) {
                console.error('Failed to remove from recent:', err);
              }
              setContextMenu((prev) => ({ ...prev, visible: false }));
            }}
            role="menuitem"
            data-testid="context-menu-remove"
          >
            {selectedCount > 1
              ? t('globalView.contextMenu.removeMultiple', {
                count: selectedCount,
                countFormatted: formatNumber(selectedCount),
              })
              : t('globalView.contextMenu.remove')}
          </button>
          {selectedCount <= 1 && contextMenu.projectPath && (
            <>
              <div className="border-t border-border my-1" />
              <button
                className="w-full px-4 py-2 text-left text-sm hover:bg-background-50 text-error flex items-center gap-2"
                onClick={() => {
                  const proj = recentProjects.find((p) => p.file_path === contextMenu.projectPath);
                  openDialog('delete-project', { path: contextMenu.projectPath, name: proj?.name, collabEnabled: proj?.collab_enabled });
                  setContextMenu((prev) => ({ ...prev, visible: false }));
                }}
                role="menuitem"
                data-testid="context-menu-delete"
              >
                {t('globalView.contextMenu.delete')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface EmptyStateProps {
  onImport: () => void;
  onNew: () => void;
  onOpen: () => void;
}

function EmptyState({ onImport, onNew, onOpen }: EmptyStateProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center h-full gap-8">
      <div className="text-center">
        <div className="text-6xl mb-4 flex items-center justify-center">
          <MapIcon size={48} />
        </div>
        <h2 className="text-2xl font-bold mb-2">{t('globalView.empty.title')}</h2>
        <p className="text-text-secondary max-w-md">
          {t('globalView.empty.description')}
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-2xl">
        <EmptyStateCard
          icon={<DownloadIcon size={28} />}
          title={t('globalView.empty.cards.import.title')}
          description={t('globalView.empty.cards.import.description')}
          onClick={() => onImport()}
          primary
          testId="empty-state-import-dmp"
        />
        <EmptyStateCard
          icon={<FilePlusIcon size={28} />}
          title={t('globalView.empty.cards.newProject.title')}
          description={t('globalView.empty.cards.newProject.description')}
          onClick={() => onNew()}
          testId="empty-state-new-project"
        />
        <EmptyStateCard
          icon={<FolderOpenIcon size={28} />}
          title={t('globalView.empty.cards.open.title')}
          description={t('globalView.empty.cards.open.description')}
          onClick={() => onOpen()}
          testId="empty-state-open-project"
        />
      </div>
    </div>
  );
}

interface EmptyStateCardProps {
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  primary?: boolean;
  testId?: string;
}

function EmptyStateCard({ icon, title, description, onClick, primary, testId }: EmptyStateCardProps) {
  return (
    <button
      onClick={onClick}
      className={`
        p-6 rounded-lg border text-left transition-all
        hover:scale-105 hover:shadow-lg
        ${primary
          ? 'bg-accent-10 border-accent hover:bg-accent-20'
          : 'bg-panel border-border hover:bg-background-50'
        }
      `}
      data-testid={testId}
    >
      <div className="text-4xl mb-3 flex items-center justify-center">{icon}</div>
      <h3 className="font-semibold mb-1">{title}</h3>
      <p className="text-sm text-text-secondary">{description}</p>
    </button>
  );
}
