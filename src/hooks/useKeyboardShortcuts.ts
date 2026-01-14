import { useEffect, useCallback } from 'react';
import { useUIStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import type { ToolType } from '../store/uiStore';

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
  const { setActiveTool, toggleSectionsPanel, toggleDetailPanel, toggleDataTable, clearSelection } = useUIStore();
  const { undo, redo, saveProject, project } = useProjectStore();

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
            // TODO: Select all
            return;
          case '0':
            // TODO: Fit to view
            return;
        }
      }

      // Handle Escape
      if (key === 'escape') {
        clearSelection();
        return;
      }

      // Handle Delete/Backspace
      if (key === 'delete' || key === 'backspace') {
        // TODO: Delete selected item
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
    [setActiveTool, toggleSectionsPanel, toggleDetailPanel, toggleDataTable, clearSelection, undo, redo, saveProject, project]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
}
