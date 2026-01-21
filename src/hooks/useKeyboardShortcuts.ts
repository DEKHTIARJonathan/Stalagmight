import { useEffect, useCallback, useRef } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useUIStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import { isNonInteractiveTool } from '../utils/toolUtils';
import { normalizeShortcut, parseKeyEvent } from '../utils/shortcuts';
import type { ToolType, Selection, DisplayToggleKey } from '../store/uiStore';
import type { ShortcutsConfig } from '../types/config';
import { defaultConfig } from '../types/config';

/**
 * Action types that can be triggered by keyboard shortcuts.
 */
type ShortcutAction =
  // Tools
  | 'select'
  | 'pan'
  | 'zoom'
  | 'quick_zoom'
  | 'draw'
  | 'delete_tool'
  | 'merge'
  | 'measure'
  | 'move_section'
  | 'move_station'
  // Edit
  | 'undo'
  | 'redo'
  | 'save'
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
  | 'toggle_data_table';

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
  move_section: 'move_section',
  move_station: 'move_station',
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
 * Check if a shortcut string contains only a key (no modifiers).
 * Used to determine if quick_zoom should use spring-loaded behavior.
 */
function isNonModifierShortcut(shortcut: string): boolean {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return false;
  // If it contains +, it has modifiers
  return !normalized.includes('+');
}

/**
 * Build a set of normalized shortcuts that should use spring-loaded behavior.
 * Only non-modifier shortcuts (single keys) are included.
 */
function buildSpringLoadedSet(bindings: string[]): Set<string> {
  const springLoaded = new Set<string>();
  for (const binding of bindings) {
    if (isNonModifierShortcut(binding)) {
      const normalized = normalizeShortcut(binding);
      if (normalized) {
        springLoaded.add(normalized);
      }
    }
  }
  return springLoaded;
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
    'quick_zoom',
    'draw',
    'delete_tool',
    'merge',
    'measure',
    'move_section',
    'move_station',
    // Edit
    'undo',
    'redo',
    'save',
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
      __cavechef_map__?: {
        getZoom: () => number;
        getMinZoom: () => number;
        getMaxZoom: () => number;
        zoomTo: (zoom: number, options?: { duration?: number }) => void;
      };
    }
  ).__cavechef_map__ ?? null;
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
    activateSpringLoaded,
    deactivateSpringLoaded,
    showStations,
    showToast,
  } = useUIStore();
  const { undo, redo, saveProject, project, stations, importDmp, config } = useProjectStore();
  const { setImportContext, hasImportedDmpPath, addImportedDmpPath } = useUIStore();

  // Ref to track which quick_zoom bindings are non-modifier (spring-loaded)
  // Uses ref to avoid stale closures in event handlers (per pitfall)
  // Initialize with defaults to handle first render before useEffect runs
  const springLoadedBindingsRef = useRef<Set<string>>(buildSpringLoadedSet(defaultConfig.shortcuts.quick_zoom));
  const shortcutMapRef = useRef<Map<string, ShortcutAction>>(buildShortcutMap(defaultConfig.shortcuts));

  // Update refs when config changes - use defaultConfig as fallback
  useEffect(() => {
    const shortcuts = config?.shortcuts ?? defaultConfig.shortcuts;

    // Build the shortcut map
    shortcutMapRef.current = buildShortcutMap(shortcuts);

    // Build set of spring-loaded bindings for quick_zoom
    springLoadedBindingsRef.current = buildSpringLoadedSet(shortcuts.quick_zoom ?? []);
  }, [config?.shortcuts]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Handle Escape FIRST - works even when focus is in an input
      if (event.key === 'Escape') {
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
        return;
      }

      // Ignore if typing in an input (for all other keys)
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) {
        return;
      }

      const isCtrlOrCmd = event.ctrlKey || event.metaKey;

      // ===== RESERVED SHORTCUTS (hardcoded) =====
      // These cannot be overridden by config

      // Handle Delete/Backspace - delete selected items
      if (event.key === 'Delete' || event.key === 'Backspace') {
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

      // Handle Ctrl+I - Import DMP (reserved)
      if (isCtrlOrCmd && event.key.toLowerCase() === 'i') {
        event.preventDefault();
        // Context-aware DMP import
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
            if (project && hasImportedDmpPath(selected)) {
              // Show confirmation dialog for duplicate import
              openDialog('confirm-duplicate-import', {
                filePath: selected,
              });
              return;
            }

            const dmpFile = await importDmp(selected);
            if (!dmpFile) return;

            // Track this file as imported
            addImportedDmpPath(selected);

            // Determine context: are we creating a new project or adding to existing?
            if (project) {
              // Existing project: open Step 1 (selection) directly
              setImportContext('existing-project');
              openDialog('dmp-selection', {
                dmpFile,
                filePath: selected,
              });
            } else {
              // No project: show NewProjectDialog for import
              setImportContext('new-project');
              const fileName = selected.split(/[/\\]/).pop()?.replace(/\.dmp$/i, '') ?? 'Imported';
              openDialog('new-project-for-import', {
                dmpFile,
                filePath: selected,
                defaultName: fileName,
              });
            }
          } catch (e) {
            openDialog('error', {
              title: 'Import Failed',
              message: e instanceof Error ? e.message : 'Failed to parse DMP file',
            });
          }
        })();
        return;
      }

      // Handle Ctrl+E - Export (reserved)
      if (isCtrlOrCmd && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        if (project) {
          openDialog('export');
        }
        return;
      }

      // Handle Ctrl+A - Select all (reserved)
      if (isCtrlOrCmd && event.key.toLowerCase() === 'a') {
        // ALWAYS prevent browser select-all
        event.preventDefault();
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

      // Check if this is a spring-loaded quick_zoom (non-modifier key)
      const isSpringLoadedQuickZoom =
        action === 'quick_zoom' && springLoadedBindingsRef.current.has(normalizedKey) && !event.repeat;

      if (isSpringLoadedQuickZoom) {
        const { activeDialog, placementMode, activeTool, springLoadedState } = useUIStore.getState();
        // Don't activate during dialogs or placement mode
        if (activeDialog || placementMode) return;
        // Don't activate if already in zoom tool or already spring-loaded
        if (activeTool === 'zoom' || springLoadedState) return;

        event.preventDefault();
        activateSpringLoaded('zoom');
        return;
      }

      // Get config values for zoom actions
      const currentConfig = useProjectStore.getState().config;
      const zoomStep = currentConfig?.map.zoom_step ?? 1.0;
      const zoomMin = currentConfig?.map.zoom_min ?? 0;
      const zoomMax = currentConfig?.map.zoom_max ?? 22;

      // Handle action
      switch (action) {
        // Tool actions
        case 'select':
        case 'pan':
        case 'draw':
        case 'delete_tool':
        case 'merge':
        case 'measure':
        case 'move_section':
        case 'move_station': {
          const tool = TOOL_ACTIONS[action];
          if (tool) {
            event.preventDefault();
            setActiveTool(tool);
          }
          break;
        }

        case 'zoom':
          // Regular toggle to zoom tool (not spring-loaded)
          event.preventDefault();
          setActiveTool('zoom');
          break;

        case 'quick_zoom':
          // With modifier key - regular toggle (spring-loaded handled above)
          event.preventDefault();
          setActiveTool('zoom');
          break;

        // Edit actions
        case 'undo':
          event.preventDefault();
          undo();
          break;

        case 'redo':
          event.preventDefault();
          redo();
          break;

        case 'save':
          event.preventDefault();
          if (project) {
            saveProject();
          }
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
            toggleDisplay(toggleKey);
          }
          break;
        }

        case 'fit_to_bounds':
          event.preventDefault();
          triggerFitToBounds();
          break;

        case 'zoom_in':
          event.preventDefault();
          handleZoomIn(zoomStep, zoomMax);
          break;

        case 'zoom_out':
          event.preventDefault();
          handleZoomOut(zoomStep, zoomMin);
          break;

        // Panel actions
        case 'toggle_sections_panel':
          event.preventDefault();
          toggleSectionsPanel();
          break;

        case 'toggle_detail_panel':
          event.preventDefault();
          toggleDetailPanel();
          break;

        case 'toggle_data_table':
          event.preventDefault();
          toggleDataTable();
          break;
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
      hasImportedDmpPath,
      addImportedDmpPath,
      importDmp,
      setImportContext,
      showStations,
      showToast,
      stations,
      selectAll,
      activateSpringLoaded,
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

  // Keyup handler for spring-loaded shortcuts
  // Unconditionally deactivate when a spring-loaded key is released
  useEffect(() => {
    const handleKeyUp = (event: KeyboardEvent) => {
      // Parse the key event to get normalized form
      const normalizedKey = parseKeyEvent(event);

      // Check if this is a spring-loaded key
      if (springLoadedBindingsRef.current.has(normalizedKey)) {
        deactivateSpringLoaded();
      }
    };

    window.addEventListener('keyup', handleKeyUp);
    return () => window.removeEventListener('keyup', handleKeyUp);
  }, [deactivateSpringLoaded]);

  // Blur handler for stuck spring-loaded keys (e.g., Alt+Tab while key held)
  // Uses cancelSpringLoaded to force restore (ignores tap threshold)
  useEffect(() => {
    const handleBlur = () => {
      // Force cancel spring-loaded state if active (always restore on blur)
      const state = useUIStore.getState();
      if (state.springLoadedState) {
        state.cancelSpringLoaded();
      }
    };

    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, []); // No dependencies - uses getState() for latest state

  // Unmount cleanup to prevent stuck spring-loaded state
  useEffect(() => {
    return () => {
      // On unmount, cancel any active spring-loaded state
      const state = useUIStore.getState();
      if (state.springLoadedState) {
        state.cancelSpringLoaded();
      }
    };
  }, []);
}
