/**
 * Keyboard shortcuts for GlobalView.
 *
 * This hook registers a single keyboard event listener for GlobalView-specific
 * shortcuts. It should be called from GlobalView component.
 *
 * Shortcuts:
 * - Enter: Open selected project(s)
 * - Delete/Backspace: Remove selected from recent
 * - Escape: Deselect all (or close context menu)
 * - Ctrl+A: Select all systems
 * - Arrow keys: Navigate to nearest system in direction (map view only)
 * - Ctrl+N: New project (configurable)
 * - Ctrl+O: Open project (configurable)
 * - Ctrl+I: Import DMP (configurable)
 */

import { useEffect, useRef, useCallback, type Dispatch, type SetStateAction } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useGlobalViewStore } from '../store/globalViewStore';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import { parseKeyEvent, normalizeShortcut } from '../utils/shortcuts';
import { defaultConfig } from '../types/config';
import type { ShortcutsConfig } from '../types/config';
import type { ProjectMetadata } from '../types/project';
import type { GlobalViewMapHandle } from '../components/GlobalView/GlobalViewMap';

/**
 * File actions available in the global view.
 */
type FileAction = 'new_file' | 'open_file' | 'import_dmp';
const FILE_ACTIONS: FileAction[] = ['new_file', 'open_file', 'import_dmp'];

/**
 * Build a shortcut map for file actions only.
 */
function buildFileShortcutMap(shortcuts: ShortcutsConfig): Map<string, FileAction> {
  const map = new Map<string, FileAction>();
  for (const action of FILE_ACTIONS) {
    const bindings = shortcuts[action];
    if (!Array.isArray(bindings)) continue;
    for (const binding of bindings) {
      const normalized = normalizeShortcut(binding);
      if (normalized) {
        map.set(normalized, action);
      }
    }
  }
  return map;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  projectPath: string | null;
}

interface UseGlobalViewShortcutsOptions {
  /** Currently selected project ID (primary selection) */
  selectedProjectId: string | null;
  /** Set for multi-selection */
  multiSelectedIds: Set<string>;
  /** Active tab ('map' or 'list') */
  activeTab: 'map' | 'list';
  /** All recent projects */
  recentProjects: ProjectMetadata[];
  /** Loading state */
  loading: { isLoading: boolean };
  /** Context menu state */
  contextMenu: ContextMenuState;
  /** Ref to map component for spatial navigation */
  mapRef: React.RefObject<GlobalViewMapHandle | null>;
  /** Callbacks */
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>;
  setMultiSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  setContextMenu: Dispatch<SetStateAction<ContextMenuState>>;
  handleProjectOpen: (filePath: string) => void;
  handleRemoveFromRecent: (filePath: string) => Promise<void>;
}

export function useGlobalViewShortcuts({
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
}: UseGlobalViewShortcutsOptions): void {
  const { clearSelection, selectSystem, setSelectedSystems } = useGlobalViewStore();
  const { openDialog, setImportContext, hasImportedDmpPath, addImportedDmpPath } = useUIStore();
  const { importDmp, config } = useProjectStore();

  // File shortcut map - config-aware, updated when config changes
  const fileShortcutMapRef = useRef(buildFileShortcutMap(defaultConfig.shortcuts));
  useEffect(() => {
    const shortcuts = config?.shortcuts ?? defaultConfig.shortcuts;
    fileShortcutMapRef.current = buildFileShortcutMap(shortcuts);
  }, [config?.shortcuts]);

  // Store values in refs to avoid stale closures in keydown handler
  const multiSelectedIdsRef = useRef(multiSelectedIds);
  const selectedProjectIdRef = useRef(selectedProjectId);
  const activeTabRef = useRef(activeTab);
  const recentProjectsRef = useRef(recentProjects);
  const loadingRef = useRef(loading);
  const contextMenuVisibleRef = useRef(contextMenu.visible);

  useEffect(() => {
    multiSelectedIdsRef.current = multiSelectedIds;
    selectedProjectIdRef.current = selectedProjectId;
    activeTabRef.current = activeTab;
    recentProjectsRef.current = recentProjects;
    loadingRef.current = loading;
    contextMenuVisibleRef.current = contextMenu.visible;
  }, [multiSelectedIds, selectedProjectId, activeTab, recentProjects, loading, contextMenu.visible]);

  // Store callbacks in refs to avoid stale closures
  const handleProjectOpenRef = useRef(handleProjectOpen);
  const handleRemoveFromRecentRef = useRef(handleRemoveFromRecent);
  useEffect(() => {
    handleProjectOpenRef.current = handleProjectOpen;
    handleRemoveFromRecentRef.current = handleRemoveFromRecent;
  }, [handleProjectOpen, handleRemoveFromRecent]);

  // Store ref for setSelectedSystems to avoid stale closure
  const setSelectedSystemsRef = useRef(setSelectedSystems);
  useEffect(() => {
    setSelectedSystemsRef.current = setSelectedSystems;
  }, [setSelectedSystems]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't handle if loading is active
      if (loadingRef.current.isLoading) return;

      // Handle context menu escape first (always allowed)
      if (e.key === 'Escape' && contextMenuVisibleRef.current) {
        e.preventDefault();
        setContextMenu((prev) => ({ ...prev, visible: false }));
        return;
      }

      // Block all other shortcuts if context menu is visible
      if (contextMenuVisibleRef.current) return;

      // Don't handle if focus is in an input element
      const activeElement = document.activeElement;
      if (
        activeElement &&
        (activeElement.tagName === 'INPUT' ||
          activeElement.tagName === 'TEXTAREA' ||
          (activeElement as HTMLElement).isContentEditable)
      ) {
        return;
      }

      const gpsProjects = recentProjectsRef.current.filter((p) => p.gps_center !== null);

      switch (e.key) {
        case 'Enter': {
          // Open the primary selected project (selectedProjectId takes precedence)
          // Fall back to first in multiSelectedIds if selectedProjectId is null
          let targetProject = selectedProjectIdRef.current;
          if (!targetProject && multiSelectedIdsRef.current.size > 0) {
            const firstSelected = [...multiSelectedIdsRef.current][0];
            if (firstSelected) {
              targetProject = firstSelected;
            }
          }
          if (targetProject) {
            e.preventDefault();
            handleProjectOpenRef.current(targetProject);
          }
          break;
        }

        case 'Delete':
        case 'Backspace': {
          // Remove selected from recent (batch to avoid multiple refreshes)
          const selected = Array.from(multiSelectedIdsRef.current);
          if (selected.length > 0) {
            e.preventDefault();
            // Remove sequentially with a single async function
            (async () => {
              for (const filePath of selected) {
                await handleRemoveFromRecentRef.current(filePath);
              }
            })();
          }
          break;
        }

        case 'Escape': {
          // Deselect all
          e.preventDefault();
          setSelectedProjectId(null);
          setMultiSelectedIds(new Set());
          clearSelection();
          break;
        }

        case 'a':
        case 'A': {
          // Ctrl+A: select all systems (on map view, only GPS projects)
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            if (activeTabRef.current === 'map') {
              // Select all GPS-positioned systems
              const allIds = new Set(gpsProjects.map((p) => p.file_path));
              setMultiSelectedIds(allIds);
              // Sync to store for map layer highlighting
              setSelectedSystemsRef.current(allIds);
              const firstGps = gpsProjects[0];
              if (firstGps) {
                setSelectedProjectId(firstGps.file_path);
              }
            } else {
              // List view: select all projects
              const allIds = new Set(recentProjectsRef.current.map((p) => p.file_path));
              setMultiSelectedIds(allIds);
              const firstProject = recentProjectsRef.current[0];
              if (firstProject) {
                setSelectedProjectId(firstProject.file_path);
              }
            }
          }
          break;
        }

        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowLeft':
        case 'ArrowRight': {
          // Arrow keys: navigate to nearest system in direction (map view only)
          if (activeTabRef.current !== 'map') break;
          if (gpsProjects.length === 0) break;

          // Only navigate if there's a selection
          const currentSelection = multiSelectedIdsRef.current;
          if (currentSelection.size === 0) break;

          // Get system centroids from map
          const centroids = mapRef.current?.getSystemCentroids();
          if (!centroids || centroids.size === 0) break;

          // Calculate centroid of current selection
          let sumLng = 0;
          let sumLat = 0;
          let count = 0;
          for (const filePath of currentSelection) {
            const center = centroids.get(filePath);
            if (center) {
              sumLng += center[0];
              sumLat += center[1];
              count++;
            }
          }
          if (count === 0) break;

          const currentCentroid: [number, number] = [sumLng / count, sumLat / count];

          // Define direction vectors (in map coordinates: lng increases right, lat increases up)
          const directionVectors: Record<string, [number, number]> = {
            ArrowUp: [0, 1], // North (positive lat)
            ArrowDown: [0, -1], // South (negative lat)
            ArrowLeft: [-1, 0], // West (negative lng)
            ArrowRight: [1, 0], // East (positive lng)
          };
          const direction = directionVectors[e.key];
          if (!direction) break;

          // Find nearest system in the specified direction using Euclidean distance
          let bestCandidate: string | null = null;
          let bestDistance = Infinity;

          for (const [filePath, center] of centroids) {
            // Skip systems already in selection
            if (currentSelection.has(filePath)) continue;

            // Calculate vector from current centroid to this system
            const dx = center[0] - currentCentroid[0];
            const dy = center[1] - currentCentroid[1];

            // Check if this system is in the specified direction (half-plane filter)
            // Dot product with direction vector must be positive
            const dotProduct = dx * direction[0] + dy * direction[1];
            if (dotProduct <= 0) continue; // Not in the right direction

            // Use Euclidean distance as the score (per spec)
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < bestDistance) {
              bestDistance = distance;
              bestCandidate = filePath;
            }
          }

          // If found, select that system and preventDefault
          if (bestCandidate) {
            e.preventDefault();
            setSelectedProjectId(bestCandidate);
            setMultiSelectedIds(new Set([bestCandidate]));
            selectSystem(bestCandidate);
          }
          break;
        }
      }

      // Configurable file shortcuts (new, open, import)
      if (e.defaultPrevented) return;
      const normalizedKey = parseKeyEvent(e);
      if (!normalizedKey || normalizedKey === 'Ctrl' || normalizedKey === 'Alt' || normalizedKey === 'Shift') {
        return;
      }

      const fileAction = fileShortcutMapRef.current.get(normalizedKey);
      if (!fileAction) return;

      switch (fileAction) {
        case 'new_file':
          e.preventDefault();
          openDialog('new-project');
          break;

        case 'open_file': {
          e.preventDefault();
          (async () => {
            try {
              const selected = await open({
                multiple: false,
                filters: [{ name: 'CaveChef Project', extensions: ['cvproj', 'cvchef'] }],
              });

              let path: string | null = null;
              if (typeof selected === 'string') {
                path = selected;
              } else if (Array.isArray(selected) && (selected as string[]).length > 0) {
                path = (selected as string[])[0] ?? null;
              }

              if (path) {
                const store = useProjectStore.getState();
                await store.loadProject(path);
              }
            } catch (err) {
              useUIStore.getState().openDialog('error', {
                title: 'Open Failed',
                message: err instanceof Error ? err.message : 'Failed to open project',
              });
            }
          })();
          break;
        }

        case 'import_dmp': {
          e.preventDefault();
          (async () => {
            try {
              const selected = await open({
                multiple: false,
                filters: [{ name: 'mNemo DMP', extensions: ['dmp'] }],
              });

              if (!selected || typeof selected !== 'string') {
                return;
              }

              // Check for duplicate import (existing project only)
              const currentProject = useProjectStore.getState().project;
              if (currentProject && hasImportedDmpPath(selected)) {
                openDialog('confirm-duplicate-import', {
                  filePath: selected,
                });
                return;
              }

              const dmpFile = await importDmp(selected);
              if (!dmpFile) return;

              addImportedDmpPath(selected);

              if (currentProject) {
                setImportContext('existing-project');
                openDialog('dmp-selection', {
                  dmpFile,
                  filePath: selected,
                });
              } else {
                setImportContext('new-project');
                const fileName = selected.split(/[/\\]/).pop()?.replace(/\.dmp$/i, '') ?? 'Imported';
                openDialog('new-project-for-import', {
                  dmpFile,
                  filePath: selected,
                  defaultName: fileName,
                });
              }
            } catch (err) {
              useUIStore.getState().openDialog('error', {
                title: 'Import Failed',
                message: err instanceof Error ? err.message : 'Failed to parse DMP file',
              });
            }
          })();
          break;
        }
      }
    },
    [clearSelection, selectSystem, setContextMenu, setMultiSelectedIds, setSelectedProjectId, mapRef,
     openDialog, setImportContext, hasImportedDmpPath, addImportedDmpPath, importDmp]
  );

  // Register single keyboard event listener
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
