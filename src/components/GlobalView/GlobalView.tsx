import { useEffect, useState, useCallback, useMemo, useRef, type MouseEvent, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useProject } from '../../hooks/useProject';
import { useGlobalViewShortcuts } from '../../hooks/useGlobalViewShortcuts';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { useGlobalViewStore } from '../../store/globalViewStore';
import { Button, IconButton } from '../common/Button';
import { BugIcon, DownloadIcon, FilePlusIcon, FolderOpenIcon, MapIcon } from '../common/icons';
import { LoadingProgress } from '../LoadingProgress';
import SystemCard from './SystemCard';
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
    handleImportDmp,
    handleImportTml,
    handleImportCompass,
  } = useProject();

  const { loading, loadRecentProjects, loadProject, resetLoading, cancelLoading, removeFromRecentProjects, config } = useProjectStore();

  // Note: useLoadingProgress() is called in App.tsx (always mounted) to avoid duplicate listeners
  const { openDialog } = useUIStore();
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

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu.visible) {
      return;
    }
    const handleClickOutside = (e: globalThis.MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu((prev) => ({ ...prev, visible: false }));
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [contextMenu.visible]);

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
      // Ctrl+click: toggle selection in multi-select mode
      setMultiSelectedIds((prev) => {
        const newSet = new Set(prev);
        if (newSet.has(filePath)) {
          newSet.delete(filePath);
        } else {
          newSet.add(filePath);
        }
        return newSet;
      });
      // Also set as primary selection for metadata panel
      setSelectedProjectId(filePath);
    } else {
      // Regular click: single select, clear multi-select
      setSelectedProjectId(filePath);
      setMultiSelectedIds(new Set([filePath]));
    }
  }, []);

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

  // Handle cancel during loading
  const handleCancelLoading = useCallback(async () => {
    await cancelLoading();
  }, [cancelLoading]);

  // Handle retry after error
  const handleRetryLoading = useCallback(async () => {
    if (loading.projectPath) {
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

  // Handle zoom to system (context menu action)
  const handleZoomToSystem = useCallback(() => {
    if (contextMenu.projectPath) {
      // Toggle to map tab if not already there
      if (activeTab !== 'map') {
        setActiveTab('map');
      }
      // Trigger zoom - use a counter pattern to ensure re-trigger even for same path
      setZoomToSystem(contextMenu.projectPath);
    }
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, [contextMenu.projectPath, activeTab]);

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

  // Get selected projects array for multi-selection support
  const selectedProjects = useMemo(() => {
    return recentProjects.filter(p => multiSelectedIds.has(p.file_path));
  }, [recentProjects, multiSelectedIds]);

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

  return (
    <div data-testid="global-view" className="h-full flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <Button onClick={() => handleImportDmp()} data-testid="global-import-dmp-button">
            {t('globalView.actions.importDmp')}
          </Button>
          <Button onClick={() => handleImportTml()} data-testid="global-import-tml-button">
            {t('globalView.actions.importTml')}
          </Button>
          <Button onClick={() => handleImportCompass()} data-testid="global-import-compass-button">
            {t('globalView.actions.importCompass')}
          </Button>
          <Button data-testid="new-project-button" onClick={() => handleNewProject()}>
            {t('globalView.actions.newProject')}
          </Button>
          <Button onClick={() => handleOpenProject()} data-testid="global-open-project-button">
            {t('globalView.actions.openProject')}
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">Stalagmight</h1>
          <Button
            onClick={() => openDialog('settings')}
            data-testid="settings-button"
            aria-label={t('globalView.actions.settings')}
          >
            {t('globalView.actions.settings')}
          </Button>
          <IconButton
            icon={<BugIcon />}
            onClick={() => openDialog('debug')}
            tooltip="Debug Logs"
            aria-label="Debug Logs"
            size="sm"
            data-testid="global-debug-button"
          />
        </div>
      </header>

      {/* Tabs - only show if there are projects (loaded or missing) */}
      {hasRecentItems && (
        <div className="flex items-center justify-between border-b border-border px-4">
          <div className="flex">
            <button
              data-testid="globalview-map-tab"
              onClick={() => setActiveTab('map')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'map'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-text-secondary hover:text-text'
              }`}
            >
              {t('globalView.tabs.map')}{' '}
              {hasGpsProjects ? `(${formatNumber(gpsProjectCount)})` : ''}
            </button>
            <button
              data-testid="globalview-list-tab"
              onClick={() => setActiveTab('list')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'list'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-text-secondary hover:text-text'
              }`}
            >
              {t('globalView.tabs.list')} ({formatNumber(recentProjects.length)})
            </button>
          </div>

          {/* Search input - on the list tab always, on the map tab when there
              are GPS projects to filter. */}
          {(activeTab === 'list' || (activeTab === 'map' && hasGpsProjects)) && (
            <div className="relative py-1">
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
              {/* Clear button (X) - only show when there's text */}
              {searchTerm && (
                <button
                  onClick={handleClearSearch}
                  className="absolute right-1 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text p-1"
                  title={t('globalView.search.clearTitle')}
                  aria-label={t('globalView.search.clearAria')}
                  data-testid="globalview-search-clear"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </div>
      )}

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
                onImport={handleImportDmp}
                onNew={handleNewProject}
                onOpen={handleOpenProject}
              />
            </div>
          ) : activeTab === 'map' ? (
            <GlobalViewMap
              ref={mapRef}
              projects={recentProjects}
              selectedProjectId={selectedProjectId}
              onProjectSelect={(path) => handleProjectSelect(path, false)}
              onProjectOpen={handleProjectOpen}
              geometryData={geometryData}
              geometryStates={geometryStates}
              searchTerm={searchTerm}
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
              <p className="text-xs text-text-secondary mb-4" data-testid="globalview-list-status">
                {isSearching
                  ? t('globalView.recent.countFiltered', {
                    shown: formatNumber(visibleItems.length),
                    total: formatNumber(listItems.length),
                  })
                  : t('globalView.recent.hint')}
              </p>

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
                  onSort={handleHeaderSort}
                  onSelect={handleProjectSelect}
                  onOpen={handleProjectOpen}
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

        {/* Metadata Panel - only show when projects exist */}
        {recentProjects.length > 0 && (
          <MetadataPanel
            project={selectedProject}
            selectedProjects={selectedProjects}
            onOpenProject={handleProjectOpen}
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
