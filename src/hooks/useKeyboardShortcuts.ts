import { useEffect, useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
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
  const { undo, redo, saveProject, project, stations, importDmp } = useProjectStore();
  const { setImportContext, hasImportedDmpPath, addImportedDmpPath } = useUIStore();

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      // Handle Escape FIRST - works even when focus is in an input
      if (key === 'escape' || key === 'esc') {
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
    [setActiveTool, toggleSectionsPanel, toggleDetailPanel, toggleDataTable, clearSelection, selectAll, triggerFitToBounds, clearMergeStations, clearMeasure, setDrawFromStation, selection, openDialog, undo, redo, saveProject, project, stations, importDmp, setImportContext, hasImportedDmpPath, addImportedDmpPath]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
}
