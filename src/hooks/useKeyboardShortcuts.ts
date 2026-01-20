import { useEffect, useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useUIStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import type { ToolType, Selection } from '../store/uiStore';

/** Shortcuts that use spring-loaded behavior (tool shortcuts only) */
const SPRING_LOADED_SHORTCUTS: Partial<Record<string, ToolType>> = {
  z: 'zoom',
};

interface ShortcutConfig {
  [key: string]: ToolType | 'undo' | 'redo' | 'save' | 'toggle_sections' | 'toggle_detail' | 'toggle_data';
}

// Note: Spring-loaded shortcuts (z) are NOT in DEFAULT_SHORTCUTS to avoid duplication
const DEFAULT_SHORTCUTS: ShortcutConfig = {
  s: 'select',
  p: 'pan',
  d: 'draw',
  x: 'delete',
  m: 'merge',
  r: 'measure',
  v: 'move_section',
  t: 'move_station',
};

export function useKeyboardShortcuts() {
  const {
    setActiveTool,
    toggleSectionsPanel,
    toggleDetailPanel,
    toggleDataTable,
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
  } = useUIStore();
  const { undo, redo, saveProject, project, stations, importDmp } = useProjectStore();
  const { setImportContext, hasImportedDmpPath, addImportedDmpPath } = useUIStore();

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      // Handle Escape FIRST - works even when focus is in an input
      if (key === 'escape') {
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

      // Handle Ctrl/Cmd shortcuts
      if (isCtrlOrCmd) {
        switch (key) {
          case 'z':
            if (event.shiftKey) {
              event.preventDefault();
              redo();
            } else {
              event.preventDefault();
              undo();
            }
            return;
          case 'y':
            event.preventDefault();
            redo();
            return;
          case 's':
            event.preventDefault();
            if (project) {
              saveProject();
            }
            return;
          case '1':
            event.preventDefault();
            toggleSectionsPanel();
            return;
          case '2':
            event.preventDefault();
            toggleDetailPanel();
            return;
          case '3':
            event.preventDefault();
            toggleDataTable();
            return;
          case 'a':
            event.preventDefault();
            if (stations.length > 0) {
              const allStations: Selection[] = stations.map((station) => ({
                type: 'station' as const,
                stationRef: station.station_ref,
              }));
              selectAll(allStations);
            }
            return;
          case '0':
            event.preventDefault();
            triggerFitToBounds();
            return;
          case 'i':
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
          case 'e':
            event.preventDefault();
            if (project) {
              openDialog('export');
            }
            return;
        }
      }

      // Handle Delete/Backspace - delete selected items
      if (key === 'delete' || key === 'backspace') {
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

      // Handle +/- for zoom (only without Ctrl/Cmd to preserve browser/app zoom behavior)
      if (!isCtrlOrCmd && (key === '+' || key === '=')) {
        event.preventDefault();
        const map = (window as unknown as { __cavechef_map__?: { getZoom: () => number; getMinZoom: () => number; getMaxZoom: () => number; zoomTo: (zoom: number, options?: { duration?: number }) => void } }).__cavechef_map__;
        if (map) {
          const config = useProjectStore.getState().config;
          const zoomStep = config?.map.zoom_step ?? 1.0;
          const maxZoom = config?.map.zoom_max ?? map.getMaxZoom();
          const currentZoom = map.getZoom();
          const targetZoom = Math.min(maxZoom, currentZoom + zoomStep);
          if (targetZoom !== currentZoom) {
            map.zoomTo(targetZoom, { duration: 300 });
          }
        }
        return;
      }
      if (!isCtrlOrCmd && key === '-') {
        event.preventDefault();
        const map = (window as unknown as { __cavechef_map__?: { getZoom: () => number; getMinZoom: () => number; getMaxZoom: () => number; zoomTo: (zoom: number, options?: { duration?: number }) => void } }).__cavechef_map__;
        if (map) {
          const config = useProjectStore.getState().config;
          const zoomStep = config?.map.zoom_step ?? 1.0;
          const minZoom = config?.map.zoom_min ?? map.getMinZoom();
          const currentZoom = map.getZoom();
          const targetZoom = Math.max(minZoom, currentZoom - zoomStep);
          if (targetZoom !== currentZoom) {
            map.zoomTo(targetZoom, { duration: 300 });
          }
        }
        return;
      }

      // Handle spring-loaded shortcuts (e.g., Z for zoom)
      const springLoadedTool = SPRING_LOADED_SHORTCUTS[key];
      if (springLoadedTool && !event.repeat) {
        const { activeDialog, placementMode, activeTool, springLoadedState } = useUIStore.getState();
        // Don't activate during dialogs or placement mode
        if (activeDialog || placementMode) return;
        // Don't activate if already in target tool or already spring-loaded
        if (activeTool === springLoadedTool || springLoadedState) return;

        activateSpringLoaded(springLoadedTool);
        return;
      }

      // Handle tool shortcuts (non-spring-loaded)
      const toolShortcut = DEFAULT_SHORTCUTS[key];
      if (toolShortcut && typeof toolShortcut === 'string' && toolShortcut !== 'undo' && toolShortcut !== 'redo' && toolShortcut !== 'save') {
        setActiveTool(toolShortcut as ToolType);
      }
    },
    [setActiveTool, toggleSectionsPanel, toggleDetailPanel, toggleDataTable, clearSelection, selectAll, triggerFitToBounds, clearMergeStations, clearMeasure, setDrawFromStation, selection, openDialog, undo, redo, saveProject, project, stations, importDmp, setImportContext, hasImportedDmpPath, addImportedDmpPath, activateSpringLoaded]
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
      const key = event.key.toLowerCase();

      // If this is a spring-loaded key, unconditionally deactivate
      // This handles both normal key release and stuck state recovery
      if (SPRING_LOADED_SHORTCUTS[key]) {
        deactivateSpringLoaded();
      }
    };

    window.addEventListener('keyup', handleKeyUp);
    return () => window.removeEventListener('keyup', handleKeyUp);
  }, [deactivateSpringLoaded]);

  // Blur handler for stuck spring-loaded keys (e.g., Alt+Tab while Z held)
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
