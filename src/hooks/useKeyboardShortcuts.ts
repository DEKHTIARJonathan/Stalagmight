import { useEffect, useCallback, useRef } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { exists } from '@tauri-apps/plugin-fs';
import { useUIStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import { isNonInteractiveTool } from '../utils/toolUtils';
import { normalizeShortcut, parseKeyEvent } from '../utils/shortcuts';
import { getErrorMessage } from '../utils/ipc';
import { extractFilename } from '../utils/path';
import {
  ensureExtension,
  projectOpenFilters,
  projectSaveFilters,
  importOpenFilters,
  PROJECT_EXTENSION,
} from '../utils/fileDialogs';
import type { ToolType, Selection, DisplayToggleKey } from '../store/uiStore';
import { setSource } from '../utils/telemetry';
import type { ShortcutsConfig, ShortcutFeedback } from '../types/config';
import { defaultConfig } from '../types/config';

/**
 * Action types that can be triggered by keyboard shortcuts.
 */
type ShortcutAction =
  // Tools
  | 'select'
  | 'pan'
  | 'zoom'
  | 'draw'
  | 'delete_tool'
  | 'merge'
  | 'measure'
  | 'move_station'
  | 'move_segment'
  | 'move_shot'
  | 'comment_tool'
  | 'move_comment_tool'
  // Edit
  | 'undo'
  | 'redo'
  // View
  | 'toggle_depth_gradient'
  | 'toggle_grid'
  | 'toggle_satellite'
  | 'toggle_station_labels'
  | 'toggle_shot_labels'
  | 'toggle_section_labels'
  | 'fit_to_bounds'
  | 'zoom_in'
  | 'zoom_out'
  // Panels
  | 'toggle_sections_panel'
  | 'toggle_detail_panel'
  | 'toggle_data_table'
  // File
  | 'new_file'
  | 'open_file'
  | 'save'
  | 'save_as'
  | 'import_dmp'
  | 'export';

/**
 * Map of action names to the corresponding tool types.
 */
const TOOL_ACTIONS: Partial<Record<ShortcutAction, ToolType>> = {
  select: 'select',
  pan: 'pan',
  zoom: 'zoom',
  draw: 'draw',
  delete_tool: 'delete',
  merge: 'merge',
  measure: 'measure',
  move_station: 'move_station',
  move_segment: 'move_segment',
  move_shot: 'move_shot',
  comment_tool: 'comment',
  move_comment_tool: 'move_comment',
};

/**
 * Map of action names to display toggle keys.
 */
const DISPLAY_TOGGLE_ACTIONS: Partial<Record<ShortcutAction, DisplayToggleKey>> = {
  toggle_depth_gradient: 'showDepthGradient',
  toggle_grid: 'showGrid',
  toggle_satellite: 'showSatellite',
  toggle_station_labels: 'showStationLabels',
  toggle_shot_labels: 'showShotData',
  toggle_section_labels: 'showSectionNames',
};

/**
 * Actions that are "non-obvious" - view toggles and panel toggles.
 * These show toasts when feedback is set to 'non_obvious' or 'all'.
 */
const NON_OBVIOUS_ACTIONS: Set<ShortcutAction> = new Set([
  // View toggles
  'toggle_depth_gradient',
  'toggle_grid',
  'toggle_satellite',
  'toggle_station_labels',
  'toggle_shot_labels',
  'toggle_section_labels',
  // Panel toggles
  'toggle_sections_panel',
  'toggle_detail_panel',
  'toggle_data_table',
]);

/**
 * Human-readable labels for shortcut actions (used in toast messages).
 */
const ACTION_LABELS: Record<ShortcutAction, string> = {
  select: 'Select tool',
  pan: 'Pan tool',
  zoom: 'Zoom tool',
  draw: 'Draw tool',
  delete_tool: 'Delete tool',
  merge: 'Merge tool',
  measure: 'Measure tool',
  move_station: 'Move station tool',
  move_segment: 'Move segment tool',
  move_shot: 'Move shot tool',
  comment_tool: 'Comment tool',
  move_comment_tool: 'Move comment tool',
  undo: 'Undo',
  redo: 'Redo',
  toggle_depth_gradient: 'Depth gradient',
  toggle_grid: 'Grid',
  toggle_satellite: 'Satellite',
  toggle_station_labels: 'Station labels',
  toggle_shot_labels: 'Shot labels',
  toggle_section_labels: 'Section labels',
  fit_to_bounds: 'Fit to bounds',
  zoom_in: 'Zoom in',
  zoom_out: 'Zoom out',
  toggle_sections_panel: 'Sections panel',
  toggle_detail_panel: 'Detail panel',
  toggle_data_table: 'Data table',
  new_file: 'New',
  open_file: 'Open',
  save: 'Save',
  save_as: 'Save As',
  import_dmp: 'Import DMP',
  export: 'Export',
};

/**
 * During placement mode, only keep display toggles and map navigation shortcuts active.
 */
const PLACEMENT_MODE_ALLOWED_SHORTCUTS: Set<ShortcutAction> = new Set([
  'toggle_depth_gradient',
  'toggle_grid',
  'toggle_satellite',
  'toggle_station_labels',
  'toggle_shot_labels',
  'toggle_section_labels',
  'fit_to_bounds',
  'zoom_in',
  'zoom_out',
]);

/**
 * Determine if a toast should be shown for an action based on feedback preference.
 */
function shouldShowToast(action: ShortcutAction, feedback: ShortcutFeedback): boolean {
  if (feedback === 'none') return false;
  if (feedback === 'all') return true;
  // 'non_obvious' - only show for view/panel toggles
  return NON_OBVIOUS_ACTIONS.has(action);
}

/**
 * Build a map from normalized shortcut strings to their action names.
 * This allows O(1) lookup during keydown handling.
 */
function buildShortcutMap(shortcuts: ShortcutsConfig): Map<string, ShortcutAction> {
  const map = new Map<string, ShortcutAction>();

  const actions: (keyof ShortcutsConfig)[] = [
    // Tools
    'select',
    'pan',
    'zoom',
    'draw',
    'delete_tool',
    'merge',
    'measure',
    'move_station',
    'move_segment',
    'move_shot',
    'comment_tool',
    'move_comment_tool',
    // Edit
    'undo',
    'redo',
    // View
    'toggle_depth_gradient',
    'toggle_grid',
    'toggle_satellite',
    'toggle_station_labels',
    'toggle_shot_labels',
    'toggle_section_labels',
    'fit_to_bounds',
    'zoom_in',
    'zoom_out',
    // Panels
    'toggle_sections_panel',
    'toggle_detail_panel',
    'toggle_data_table',
    // File
    'new_file',
    'open_file',
    'save',
    'save_as',
    'import_dmp',
    'export',
  ];

  for (const action of actions) {
    const bindings = shortcuts[action];
    if (!Array.isArray(bindings)) continue;

    for (const binding of bindings) {
      const normalized = normalizeShortcut(binding);
      if (normalized) {
        map.set(normalized, action as ShortcutAction);
      }
    }
  }

  return map;
}

/**
 * Get global map reference from window.
 */
function getMap(): {
  getZoom: () => number;
  getMinZoom: () => number;
  getMaxZoom: () => number;
  zoomTo: (zoom: number, options?: { duration?: number }) => void;
} | null {
  return (
    window as unknown as {
      __stalagmight_map__?: {
        getZoom: () => number;
        getMinZoom: () => number;
        getMaxZoom: () => number;
        zoomTo: (zoom: number, options?: { duration?: number }) => void;
      };
    }
  ).__stalagmight_map__ ?? null;
}

/**
 * Handle zoom in action with configurable step and limits.
 */
function handleZoomIn(zoomStep: number, zoomMax: number): void {
  const map = getMap();
  if (!map) return;

  const currentZoom = map.getZoom();
  const maxZoom = Math.min(zoomMax, map.getMaxZoom());
  const targetZoom = Math.min(maxZoom, currentZoom + zoomStep);

  if (targetZoom !== currentZoom) {
    map.zoomTo(targetZoom, { duration: 300 });
  }
}

/**
 * Handle zoom out action with configurable step and limits.
 */
function handleZoomOut(zoomStep: number, zoomMin: number): void {
  const map = getMap();
  if (!map) return;

  const currentZoom = map.getZoom();
  const minZoom = Math.max(zoomMin, map.getMinZoom());
  const targetZoom = Math.max(minZoom, currentZoom - zoomStep);

  if (targetZoom !== currentZoom) {
    map.zoomTo(targetZoom, { duration: 300 });
  }
}

export function useKeyboardShortcuts() {
  const {
    setActiveTool,
    toggleSectionsPanel,
    toggleDetailPanel,
    toggleDataTable,
    toggleDisplay,
    clearSelection,
    selectAll,
    triggerFitToBounds,
    selection,
    openDialog,
    clearMergeStations,
    clearMeasure,
    setDrawFromStation,
    showStations,
    showToast,
  } = useUIStore();
  const { undo, redo, saveProject, project, stations, importDmp, parseTml, parseGpx, executeTmlImport, config } = useProjectStore();
  const { setImportContext } = useUIStore();

  // Ref for shortcut map - uses ref to avoid stale closures in event handlers
  // Initialize with defaults to handle first render before useEffect runs
  const shortcutMapRef = useRef<Map<string, ShortcutAction>>(buildShortcutMap(defaultConfig.shortcuts));

  // Update ref when config changes - use defaultConfig as fallback
  useEffect(() => {
    const shortcuts = config?.shortcuts ?? defaultConfig.shortcuts;
    shortcutMapRef.current = buildShortcutMap(shortcuts);
  }, [config?.shortcuts]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const { activeDialog } = useUIStore.getState();
      if (activeDialog && event.key !== 'Escape') {
        // Allow ? to toggle the keyboard shortcuts overlay closed
        if (!(event.key === '?' && activeDialog === 'keyboard-shortcuts')) {
          return;
        }
      }

      setSource('keyboard');

      const placementModeActive = useUIStore.getState().placementMode !== null;

      // Handle Cmd/Ctrl+, to open Settings - works even when focus is in an input
      // Must be BEFORE the input guard check
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        if (placementModeActive) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        // Only open if Settings is not already open
        if (activeDialog !== 'settings') {
          openDialog('settings');
        }
        return;
      }

      // Handle Escape FIRST - works even when focus is in an input
      if (event.key === 'Escape') {
        // Placement mode owns Escape behavior (handled in MapCanvas).
        if (placementModeActive) {
          return;
        }

        // Skip if already handled (e.g., by a dropdown closing)
        if (event.defaultPrevented) {
          return;
        }

        // Skip if a dropdown is open - let the dropdown handle Escape first
        const openDropdown = document.querySelector('[data-dropdown-open]');
        if (openDropdown) {
          return;
        }

        // Close any open dialog
        const { activeDialog, closeDialog } = useUIStore.getState();
        if (activeDialog) {
          event.preventDefault();
          closeDialog();
          // IMPORTANT: Don't return - continue to clear tool state
        }

        // Always clear tool state (existing behavior)
        clearSelection();
        clearMergeStations();
        clearMeasure();
        setDrawFromStation(null);
        useUIStore.getState().clearCommentTarget();
        // Cancel move comment — no backend restore needed (pickup doesn't mutate backend)
        useUIStore.getState().clearMoveCommentSource();
        return;
      }

      // Ignore if typing in an input (for all other keys)
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      ) {
        return;
      }

      const isCtrlOrCmd = event.ctrlKey || event.metaKey;

      // ===== RESERVED SHORTCUTS (hardcoded) =====
      // These cannot be overridden by config

      // Handle Delete/Backspace - delete selected items
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (placementModeActive) {
          event.preventDefault();
          return;
        }
        // GUARD: No delete for pan/zoom tools
        const currentToolDel = useUIStore.getState().activeTool;
        if (isNonInteractiveTool(currentToolDel)) return;

        if (selection) {
          if (selection.type === 'shot' && selection.sectionId !== undefined && selection.shotId !== undefined) {
            openDialog('confirm-delete', {
              type: 'shot',
              sectionId: selection.sectionId,
              shotId: selection.shotId,
            });
          } else if (selection.type === 'station' && selection.stationRef) {
            openDialog('confirm-delete', {
              type: 'station',
              stationRef: selection.stationRef,
            });
          } else if (selection.type === 'section' && selection.sectionId !== undefined) {
            openDialog('confirm-delete', {
              type: 'section',
              sectionId: selection.sectionId,
            });
          }
        }
        return;
      }

      // Handle Ctrl+A - Select all (reserved)
      if (isCtrlOrCmd && event.key.toLowerCase() === 'a') {
        // ALWAYS prevent browser select-all
        event.preventDefault();
        if (placementModeActive) {
          return;
        }
        // GUARD: No select all for pan/zoom tools
        const currentToolA = useUIStore.getState().activeTool;
        if (isNonInteractiveTool(currentToolA)) return;
        // GUARD: Block select all when stations are hidden
        if (!showStations) {
          showToast("Enable 'Stations' in Display menu to select all", 'stations-hidden');
          return;
        }
        if (stations.length > 0) {
          const allStations: Selection[] = stations.map((station) => ({
            type: 'station' as const,
            stationRef: station.station_ref,
          }));
          selectAll(allStations);
        }
        return;
      }

      // Toggle keyboard shortcuts overlay
      if (event.key === '?') {
        event.preventDefault();
        if (placementModeActive) {
          return;
        }
        const { activeDialog: currentDialog } = useUIStore.getState();
        if (currentDialog === 'keyboard-shortcuts') {
          useUIStore.getState().closeDialog();
        } else if (!currentDialog) {
          openDialog('keyboard-shortcuts');
        }
        return;
      }

      // ===== CONFIGURABLE SHORTCUTS =====
      // Parse the key event into normalized form for lookup
      const normalizedKey = parseKeyEvent(event);
      if (!normalizedKey || normalizedKey === 'Ctrl' || normalizedKey === 'Alt' || normalizedKey === 'Shift') {
        // Modifier-only press, ignore
        return;
      }

      const shortcutMap = shortcutMapRef.current;
      const action = shortcutMap.get(normalizedKey);

      if (!action) {
        // No action mapped to this shortcut
        return;
      }

      if (placementModeActive && !PLACEMENT_MODE_ALLOWED_SHORTCUTS.has(action)) {
        event.preventDefault();
        return;
      }

      // Get config values for zoom actions
      const currentConfig = useProjectStore.getState().config;
      const zoomStep = currentConfig?.map.zoom_step ?? 1.0;
      const zoomMin = currentConfig?.map.zoom_min ?? 0;
      const zoomMax = currentConfig?.map.zoom_max ?? 22;
      const shortcutFeedback = currentConfig?.general.shortcut_feedback ?? 'non_obvious';

      // Helper to show toast if appropriate for this action
      const maybeShowToast = (actionName: ShortcutAction, stateInfo?: string) => {
        if (shouldShowToast(actionName, shortcutFeedback)) {
          const label = ACTION_LABELS[actionName];
          const message = stateInfo ? `${label}: ${stateInfo}` : label;
          showToast(message, `shortcut-${actionName}`);
        }
      };

      // Handle action
      switch (action) {
        // Tool actions
        case 'select':
        case 'pan':
        case 'draw':
        case 'delete_tool':
        case 'merge':
        case 'measure':
        case 'move_station':
        case 'move_segment':
        case 'move_shot':
        case 'comment_tool':
        case 'move_comment_tool': {
          const tool = TOOL_ACTIONS[action];
          if (tool) {
            event.preventDefault();
            setActiveTool(tool);
            maybeShowToast(action);
          }
          break;
        }

        case 'zoom':
          // Regular toggle to zoom tool
          event.preventDefault();
          setActiveTool('zoom');
          maybeShowToast(action);
          break;

        // Edit actions
        case 'undo':
          event.preventDefault();
          undo();
          maybeShowToast(action);
          break;

        case 'redo':
          event.preventDefault();
          redo();
          maybeShowToast(action);
          break;

        // View toggle actions
        case 'toggle_depth_gradient':
        case 'toggle_grid':
        case 'toggle_satellite':
        case 'toggle_station_labels':
        case 'toggle_shot_labels':
        case 'toggle_section_labels': {
          const toggleKey = DISPLAY_TOGGLE_ACTIONS[action];
          if (toggleKey) {
            event.preventDefault();
            // Get current state before toggle to report new state
            const currentState = useUIStore.getState()[toggleKey];
            toggleDisplay(toggleKey);
            maybeShowToast(action, currentState ? 'Off' : 'On');
          }
          break;
        }

        case 'fit_to_bounds':
          event.preventDefault();
          triggerFitToBounds();
          maybeShowToast(action);
          break;

        case 'zoom_in':
          event.preventDefault();
          handleZoomIn(zoomStep, zoomMax);
          maybeShowToast(action);
          break;

        case 'zoom_out':
          event.preventDefault();
          handleZoomOut(zoomStep, zoomMin);
          maybeShowToast(action);
          break;

        // Panel actions
        case 'toggle_sections_panel': {
          event.preventDefault();
          const sectionsPanelOpen = useUIStore.getState().sectionsPanelOpen;
          toggleSectionsPanel();
          maybeShowToast(action, sectionsPanelOpen ? 'Hidden' : 'Visible');
          break;
        }

        case 'toggle_detail_panel': {
          event.preventDefault();
          const detailPanelOpen = useUIStore.getState().detailPanelOpen;
          toggleDetailPanel();
          maybeShowToast(action, detailPanelOpen ? 'Hidden' : 'Visible');
          break;
        }

        case 'toggle_data_table': {
          event.preventDefault();
          const dataTableOpen = useUIStore.getState().dataTableOpen;
          toggleDataTable();
          maybeShowToast(action, dataTableOpen ? 'Hidden' : 'Visible');
          break;
        }

        // File actions
        case 'new_file':
          event.preventDefault();
          openDialog('new-project');
          maybeShowToast(action);
          break;

        case 'open_file': {
          event.preventDefault();
          (async () => {
            try {
              const selected = await open({
                multiple: false,
                filters: projectOpenFilters(),
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
            } catch (e) {
              openDialog('error', {
                title: 'Open Failed',
                message: getErrorMessage(e, 'Failed to open project'),
              });
            }
          })();
          break;
        }

        case 'save':
          event.preventDefault();
          if (project) {
            saveProject();
            maybeShowToast(action);
          }
          break;

        case 'save_as': {
          event.preventDefault();
          const currentProjectSA = useProjectStore.getState().project;
          if (currentProjectSA) {
            (async () => {
              try {
                const selected = await save({
                  filters: projectSaveFilters(),
                });

                if (selected) {
                  const finalPath = ensureExtension(selected, PROJECT_EXTENSION);

                  try {
                    const fileExists = await exists(finalPath);
                    if (fileExists) {
                      openDialog('confirm-overwrite', {
                        path: finalPath,
                        fileName: finalPath.split('/').pop() ?? finalPath,
                      });
                      return;
                    }
                  } catch {
                    // If exists check fails, proceed with save
                  }

                  const store = useProjectStore.getState();
                  const result = await store.saveProject(finalPath);
                  if (result && !result.success && result.error) {
                    openDialog('error', { message: result.error, title: 'Save Failed' });
                  }
                }
              } catch (e) {
                openDialog('error', {
                  title: 'Save Failed',
                  message: getErrorMessage(e, 'Failed to save project'),
                });
              }
            })();
            maybeShowToast(action);
          }
          break;
        }

        case 'import_dmp': {
          event.preventDefault();
          // Context-aware import (DMP + TML/TMLU)
          (async () => {
            try {
              const selected = await open({
                multiple: false,
                filters: importOpenFilters(),
              });

              if (!selected || typeof selected !== 'string') {
                return;
              }

              const lowerPath = selected.toLowerCase();
              if (lowerPath.endsWith('.gpx')) {
                // GPX import
                const gpxFile = await parseGpx(selected);
                if (!gpxFile) return;

                const currentProject = useProjectStore.getState().project;
                if (currentProject) {
                  openDialog('gpx-selection', { gpxFile, filePath: selected });
                } else {
                  const fileName = extractFilename(selected, /\.gpx$/i) || 'Imported';
                  openDialog('new-project-for-import', {
                    gpxFile,
                    filePath: selected,
                    defaultName: fileName,
                    importType: 'gpx',
                  });
                }
              } else if (lowerPath.endsWith('.tml') || lowerPath.endsWith('.tmlu')) {
                // TML/TMLU import
                const currentProject = useProjectStore.getState().project;
                if (currentProject) {
                  const tmlFile = await parseTml(selected);
                  if (tmlFile) {
                    openDialog('tml-import', { tmlFile, filePath: selected });
                  }
                } else {
                  const tmlFile = await parseTml(selected);
                  if (tmlFile) {
                    const fileName = extractFilename(selected, /\.tmlu?$/i) || 'Imported';
                    openDialog('new-project-for-import', {
                      tmlFile,
                      filePath: selected,
                      defaultName: fileName,
                      importType: 'tml',
                    });
                  }
                }
              } else {
                // DMP import
                const dmpFile = await importDmp(selected);
                if (!dmpFile) return;

                const currentProject = useProjectStore.getState().project;
                if (currentProject) {
                  setImportContext('existing-project');
                  openDialog('dmp-selection', {
                    dmpFile,
                    filePath: selected,
                  });
                } else {
                  setImportContext('new-project');
                  const fileName = extractFilename(selected, /\.dmp$/i) || 'Imported';
                  openDialog('new-project-for-import', {
                    dmpFile,
                    filePath: selected,
                    defaultName: fileName,
                  });
                }
              }
            } catch (e) {
              openDialog('error', {
                title: 'Import Failed',
                message: getErrorMessage(e, 'Failed to import file'),
              });
            }
          })();
          break;
        }

        case 'export': {
          event.preventDefault();
          const currentProject = useProjectStore.getState().project;
          if (currentProject) {
            openDialog('export');
          }
          break;
        }
      }
    },
    [
      clearSelection,
      clearMergeStations,
      clearMeasure,
      setDrawFromStation,
      selection,
      openDialog,
      project,
      importDmp,
      parseTml,
      parseGpx,
      executeTmlImport,
      setImportContext,
      showStations,
      showToast,
      stations,
      selectAll,
      setActiveTool,
      undo,
      redo,
      saveProject,
      toggleDisplay,
      triggerFitToBounds,
      toggleSectionsPanel,
      toggleDetailPanel,
      toggleDataTable,
    ]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
}
