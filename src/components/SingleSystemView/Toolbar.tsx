import { useState, useRef, useEffect, useCallback } from 'react';
import { useUIStore, type ToolType } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button, IconButton } from '../common/Button';
import DisplayMenu from './DisplayMenu';
import UndoHistoryDropdown from './UndoHistoryDropdown';
import { TOOL_GROUPS, type ToolGroupDef } from '../../utils/toolGroups';
import { defaultConfig } from '../../types/config';

interface ToolbarProps {
  projectName: string;
  onBack: () => void;
  onSave: () => void;
  onImport: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

/** Tool metadata for standalone tools */
interface StandaloneTool {
  kind: 'standalone';
  id: ToolType;
  label: string;
  shortcut: string;
}

/** Tool group reference for grouped tools */
interface GroupRef {
  kind: 'group';
  groupId: string;
}

/** Separator between tool clusters */
interface Separator {
  kind: 'separator';
}

type ToolbarItem = StandaloneTool | GroupRef | Separator;

/**
 * Get the display shortcut string for a tool from the shortcuts config.
 * Returns the first binding or empty string if none.
 */
function getShortcutForTool(tool: ToolType, shortcuts: Record<string, string[]>): string {
  // Map tool type to shortcut config key
  const keyMap: Record<ToolType, string> = {
    select: 'select',
    pan: 'pan',
    zoom: 'zoom',
    draw: 'draw',
    delete: 'delete_tool',
    merge: 'merge',
    measure: 'measure',
    move_section: 'move_section',
    move_station: 'move_station',
    move_segment: 'move_segment',
    move_shot: 'move_shot',
  };
  const configKey = keyMap[tool];
  const bindings = shortcuts[configKey];
  if (Array.isArray(bindings) && bindings.length > 0) {
    return bindings[0] ?? '';
  }
  return '';
}

/**
 * Format a tooltip string for a tool, including shortcut key if available.
 */
function formatTooltip(label: string, shortcut: string): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

/** Human-readable tool labels */
const TOOL_LABELS: Record<ToolType, string> = {
  select: 'Select',
  pan: 'Pan',
  zoom: 'Zoom',
  draw: 'Draw',
  delete: 'Delete',
  merge: 'Merge',
  measure: 'Measure',
  move_section: 'Move Section',
  move_station: 'Move Station',
  move_segment: 'Move Segment',
  move_shot: 'Move Shot',
};

/**
 * Toolbar layout definition.
 * [Select] | [Navigate group] | [Draw] [Delete] [Merge] [Measure] | [Move group]
 */
const TOOLBAR_ITEMS: ToolbarItem[] = [
  { kind: 'standalone', id: 'select', label: 'Select', shortcut: 'S' },
  { kind: 'separator' },
  { kind: 'group', groupId: 'navigate' },
  { kind: 'separator' },
  { kind: 'standalone', id: 'draw', label: 'Draw', shortcut: 'D' },
  { kind: 'standalone', id: 'delete', label: 'Delete', shortcut: 'X' },
  { kind: 'standalone', id: 'merge', label: 'Merge', shortcut: 'M' },
  { kind: 'standalone', id: 'measure', label: 'Measure', shortcut: 'R' },
  { kind: 'separator' },
  { kind: 'group', groupId: 'move' },
];

export default function Toolbar({
  projectName,
  onBack,
  onSave,
  onImport,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: ToolbarProps) {
  const { activeTool, setActiveTool, openDialog } = useUIStore();

  return (
    <header className="flex items-center justify-between px-4 py-2 border-b border-border bg-panel" data-testid="toolbar">
      {/* Left section */}
      <div className="flex items-center gap-2">
        <Button onClick={onBack} size="sm" data-testid="back-button">
          ← Back
        </Button>
        <Button onClick={onSave} size="sm" data-testid="toolbar-save-button">
          Save
        </Button>
        <Button onClick={() => onImport()} size="sm" data-testid="toolbar-import-button">
          Import
        </Button>
        <Button onClick={() => openDialog('export')} size="sm" data-testid="toolbar-export-button">
          Export
        </Button>
        <div className="w-px h-6 bg-border mx-2" />
        <UndoHistoryDropdown
          mode="undo"
          disabled={!canUndo}
          onSingleAction={onUndo}
          testId="toolbar-undo-button"
        >
          <span className="inline-flex items-center gap-0.5">
            Undo
            {canUndo && <span className="text-[10px] opacity-60" aria-hidden="true" data-testid="undo-chevron">{' '}▾</span>}
          </span>
        </UndoHistoryDropdown>
        <UndoHistoryDropdown
          mode="redo"
          disabled={!canRedo}
          onSingleAction={onRedo}
          testId="toolbar-redo-button"
        >
          <span className="inline-flex items-center gap-0.5">
            Redo
            {canRedo && <span className="text-[10px] opacity-60" aria-hidden="true" data-testid="redo-chevron">{' '}▾</span>}
          </span>
        </UndoHistoryDropdown>
      </div>

      {/* Center - project name */}
      <h1 className="font-medium" data-testid="toolbar-project-name">{projectName}</h1>

      {/* Right section - tools and display menu */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 bg-background rounded px-1 py-1">
          {TOOLBAR_ITEMS.map((item, index) => {
            if (item.kind === 'separator') {
              return <div key={`sep-${index}`} className="w-px h-6 bg-border mx-1" />;
            }
            if (item.kind === 'standalone') {
              return (
                <IconButton
                  key={item.id}
                  icon={<ToolIcon tool={item.id} />}
                  active={activeTool === item.id}
                  onClick={() => setActiveTool(item.id)}
                  tooltip={`${item.label} (${item.shortcut})`}
                  size="sm"
                  aria-pressed={activeTool === item.id}
                  data-testid={`tool-${item.id}`}
                />
              );
            }
            // group
            const group = TOOL_GROUPS.find((g) => g.id === item.groupId);
            if (!group) return null;
            return (
              <ToolGroupButton
                key={group.id}
                group={group}
                activeTool={activeTool}
                onActivateTool={setActiveTool}
              />
            );
          })}
        </div>
        <DisplayMenu />
      </div>
    </header>
  );
}

interface ToolGroupButtonProps {
  group: ToolGroupDef;
  activeTool: ToolType;
  onActivateTool: (tool: ToolType) => void;
}

function ToolGroupButton({ group, activeTool, onActivateTool }: ToolGroupButtonProps) {
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);

  const lastSubtoolByGroup = useUIStore((s) => s.lastSubtoolByGroup);
  const config = useProjectStore((s) => s.config);
  const shortcuts = config?.shortcuts ?? defaultConfig.shortcuts;

  // Determine which subtool is currently displayed on the button
  const isGroupActive = group.tools.includes(activeTool);
  const displayTool: ToolType = isGroupActive
    ? activeTool
    : (lastSubtoolByGroup[group.id] ?? group.defaultTool);

  // Centralized close helper: closes flyout and restores focus to group button
  const closeFlyout = useCallback(() => {
    setFlyoutOpen(false);
    requestAnimationFrame(() => {
      buttonRef.current?.focus();
    });
  }, []);

  // Left-click: If group inactive, activate last-used subtool. If active, cycle.
  const handleClick = useCallback(() => {
    if (!isGroupActive) {
      onActivateTool(displayTool);
    } else {
      // Cycle to next subtool
      const currentIndex = group.tools.indexOf(activeTool);
      const nextIndex = (currentIndex + 1) % group.tools.length;
      const nextTool = group.tools[nextIndex];
      if (nextTool !== undefined) {
        onActivateTool(nextTool);
      }
    }
  }, [isGroupActive, displayTool, activeTool, group.tools, onActivateTool]);

  // Right-click: Toggle flyout
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setFlyoutOpen((prev) => !prev);
  }, []);

  // Close flyout when clicking outside
  useEffect(() => {
    if (!flyoutOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (buttonRef.current?.contains(target)) return;
      if (flyoutRef.current?.contains(target)) return;
      closeFlyout();
    };

    // Use a microtask delay to avoid the click that opened the flyout from
    // immediately closing it
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [flyoutOpen, closeFlyout]);

  // Focus management: when flyout opens, focus the active subtool item
  useEffect(() => {
    if (!flyoutOpen) {
      setFocusedIndex(-1);
      return;
    }

    // Find active subtool index, or default to first
    const activeIndex = group.tools.indexOf(activeTool);
    const initialIndex = activeIndex >= 0 ? activeIndex : 0;
    setFocusedIndex(initialIndex);
  }, [flyoutOpen, group.tools, activeTool]);

  // Focus the element when focusedIndex changes
  useEffect(() => {
    if (!flyoutOpen || focusedIndex < 0) return;
    const flyout = flyoutRef.current;
    if (!flyout) return;
    const items = flyout.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items[focusedIndex]?.focus();
  }, [flyoutOpen, focusedIndex]);

  // Keyboard handler for the flyout
  const handleFlyoutKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        setFocusedIndex((prev) => (prev + 1) % group.tools.length);
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        setFocusedIndex((prev) => (prev - 1 + group.tools.length) % group.tools.length);
        break;
      }
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const selectedTool = group.tools[focusedIndex];
        if (focusedIndex >= 0 && focusedIndex < group.tools.length && selectedTool !== undefined) {
          onActivateTool(selectedTool);
          closeFlyout();
        }
        break;
      }
      case 'Escape': {
        e.preventDefault();
        e.stopPropagation();
        closeFlyout();
        break;
      }
    }
  }, [focusedIndex, group.tools, onActivateTool, closeFlyout]);

  // Handle clicking a subtool in the flyout (mouse path also restores focus)
  const handleSubtoolClick = useCallback((tool: ToolType) => {
    onActivateTool(tool);
    closeFlyout();
  }, [onActivateTool, closeFlyout]);

  const displayShortcut = getShortcutForTool(displayTool, shortcuts as unknown as Record<string, string[]>);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        className={`
          relative inline-flex items-center justify-center rounded
          transition-colors w-6 h-6
          text-text-primary hover:bg-panel
          disabled:opacity-50 disabled:cursor-not-allowed
          ${isGroupActive ? 'ring-2 ring-accent' : ''}
        `}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={formatTooltip(TOOL_LABELS[displayTool], displayShortcut)}
        aria-pressed={isGroupActive}
        aria-haspopup="true"
        aria-expanded={flyoutOpen}
        data-testid={`tool-group-${group.id}`}
      >
        <ToolIcon tool={displayTool} />
        {/* Triangle indicator for grouped button */}
        <span
          className="absolute bottom-0 right-0 text-[6px] leading-none text-text-secondary pointer-events-none"
          aria-hidden="true"
        >
          ▾
        </span>
      </button>

      {flyoutOpen && (
        <div
          ref={flyoutRef}
          className="absolute top-full left-0 mt-1 z-50 bg-panel border border-border rounded shadow-lg py-1 min-w-[10rem]"
          role="menu"
          aria-label={`${group.id} tools`}
          onKeyDown={handleFlyoutKeyDown}
          data-testid={`subtool-flyout-${group.id}`}
        >
          {group.tools.map((tool, index) => {
            const shortcut = getShortcutForTool(tool, shortcuts as unknown as Record<string, string[]>);
            const isActive = tool === activeTool;
            const isFocused = index === focusedIndex;
            return (
              <button
                key={tool}
                role="menuitem"
                className={`
                  flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left
                  transition-colors
                  ${isActive ? 'bg-accent/20 text-accent' : 'text-text-primary hover:bg-border'}
                  ${isFocused ? 'outline outline-2 outline-accent outline-offset-[-2px]' : ''}
                `}
                onClick={() => handleSubtoolClick(tool)}
                tabIndex={isFocused ? 0 : -1}
                aria-current={isActive ? 'true' : undefined}
                data-testid={`subtool-${tool}`}
              >
                <span className="w-5 text-center"><ToolIcon tool={tool} /></span>
                <span className="flex-1">{TOOL_LABELS[tool]}</span>
                {shortcut && <span className="text-text-secondary text-xs ml-2">{shortcut}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ToolIcon({ tool }: { tool: ToolType }) {
  // Simple text icons - can be replaced with SVG icons
  const icons: Record<ToolType, string> = {
    select: '↖',
    pan: '✋',
    zoom: '🔍',
    draw: '✏',
    delete: '✕',
    merge: '⊕',
    measure: '📏',
    move_section: '↔',
    move_station: '⤢',
    move_segment: '⇔',
    move_shot: '↗',
  };

  return <span className="text-sm">{icons[tool]}</span>;
}
