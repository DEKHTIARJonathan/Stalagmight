import { useEffect, useCallback } from 'react';
import { useUIStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import type { ToolType, Selection } from '../store/uiStore';

interface ShortcutConfig {
  [key: string]: ToolType | 'undo' | 'redo' | 'save' | 'toggle_sections' | 'toggle_detail' | 'toggle_data';
}

const DEFAULT_SHORTCUTS: ShortcutConfig = {
  s: 'select',
  p: 'pan',
  z: 'zoom',
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
  } = useUIStore();
  const { undo, redo, saveProject, project, stations } = useProjectStore();

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Ignore if typing in an input
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) {
        return;
      }

      const key = event.key.toLowerCase();
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
            openDialog('import-dmp');
            return;
          case 'e':
            event.preventDefault();
            if (project) {
              openDialog('export');
            }
            return;
        }
      }

      // Handle Escape - clear all tool state and selection
      if (key === 'escape') {
        clearSelection();
        clearMergeStations();
        clearMeasure();
        setDrawFromStation(null);
        return;
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

      // Handle +/- for zoom
      if (key === '+' || key === '=') {
        // TODO: Zoom in
        return;
      }
      if (key === '-') {
        // TODO: Zoom out
        return;
      }

      // Handle tool shortcuts
      const toolShortcut = DEFAULT_SHORTCUTS[key];
      if (toolShortcut && typeof toolShortcut === 'string' && toolShortcut !== 'undo' && toolShortcut !== 'redo' && toolShortcut !== 'save') {
        setActiveTool(toolShortcut as ToolType);
      }
    },
    [setActiveTool, toggleSectionsPanel, toggleDetailPanel, toggleDataTable, clearSelection, selectAll, triggerFitToBounds, clearMergeStations, clearMeasure, setDrawFromStation, selection, openDialog, undo, redo, saveProject, project, stations]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
}
