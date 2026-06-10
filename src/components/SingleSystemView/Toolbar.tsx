import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore, type ToolType } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button, IconButton } from '../common/Button';
import {
  ArrowLeftIcon,
  BugIcon,
  ChevronDownIcon,
  ShrinkIcon,
} from '../common/icons';
import { ToolGlyph, toolAccentVar } from '../common/toolIcons';
import type { CSSProperties } from 'react';
import DisplayMenu from './DisplayMenu';
import TableSelectDropdown from './TableSelectDropdown';
import UndoHistoryDropdown from './UndoHistoryDropdown';
import { TOOL_GROUPS, type ToolGroupDef } from '../../utils/toolGroups';
import { isMutatingTool } from '../../utils/toolUtils';
import { setSource } from '../../utils/telemetry';
import { defaultConfig } from '../../types/config';

interface ToolbarProps {
  onBack: () => void;
  onSave: () => void;
  onImport: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  placementModeActive: boolean;
  /** Reduced variant while the data table is fullscreen: Close/Save/Undo/Redo
   *  stay, Import/Export gray out, tools give way to the table picker and a
   *  "Map view" shrink button. */
  dataTableFullScreen: boolean;
}

/** Tool metadata for standalone tools */
interface StandaloneTool {
  kind: 'standalone';
  id: ToolType;
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
    merge: 'merge',
    measure: 'measure',
    move_station: 'move_station',
    move_segment: 'move_segment',
    move_shot: 'move_shot',
    comment: 'comment_tool',
    move_comment: 'move_comment_tool',
  };
  const configKey = keyMap[tool];
  const bindings = shortcuts[configKey];
  if (Array.isArray(bindings) && bindings.length > 0) {
    return bindings[0] ?? '';
  }
  return '';
}

/** Translation keys for tool labels */
const TOOL_LABEL_KEYS: Record<ToolType, string> = {
  select: 'toolbar.tools.select',
  pan: 'toolbar.tools.pan',
  zoom: 'toolbar.tools.zoom',
  merge: 'toolbar.tools.merge',
  measure: 'toolbar.tools.measure',
  move_station: 'toolbar.tools.moveStation',
  move_segment: 'toolbar.tools.moveSegment',
  move_shot: 'toolbar.tools.moveShot',
  comment: 'toolbar.tools.comment',
  move_comment: 'toolbar.tools.moveComment',
};

const TOOL_GROUP_LABEL_KEYS: Record<string, string> = {
  navigate: 'toolbar.groups.navigate',
  comment: 'toolbar.groups.comment',
  move: 'toolbar.groups.move',
};

/**
 * Toolbar layout definition (#51): navigation tools, a divider, the action
 * tools, a divider, then the standalone measure tool.
 * [Select Pan/Zoom] | [Merge Comment Move] | [Measure]
 */
const TOOLBAR_ITEMS: ToolbarItem[] = [
  { kind: 'standalone', id: 'select', shortcut: 'S' },
  { kind: 'group', groupId: 'navigate' },
  { kind: 'separator' },
  { kind: 'standalone', id: 'merge', shortcut: 'M' },
  { kind: 'group', groupId: 'comment' },
  { kind: 'group', groupId: 'move' },
  { kind: 'separator' },
  { kind: 'standalone', id: 'measure', shortcut: 'R' },
];

export default function Toolbar({
  onBack,
  onSave,
  onImport,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  placementModeActive,
  dataTableFullScreen,
}: ToolbarProps) {
  const { t } = useTranslation();
  const activeTool = useUIStore((s) => s.activeTool);
  const setActiveTool = useUIStore((s) => s.setActiveTool);
  const openDialog = useUIStore((s) => s.openDialog);
  const exitDataTableFullScreen = useUIStore((s) => s.exitDataTableFullScreen);
  // The closure-adjusted view is read-only: geometry-mutating tools are disabled
  // there (edits are made in the measured view).
  const geometryReadOnly = useUIStore((s) => s.geometryMode === 'closureAdjusted');

  return (
    <header className="flex items-center justify-between px-4 py-2 border-b border-border bg-panel" data-testid="toolbar">
      {/* Left section */}
      <div
        className={`flex items-center gap-2 transition-opacity ${placementModeActive ? 'opacity-45 grayscale' : ''}`}
        data-testid="toolbar-file-controls"
      >
        <Button
          onClick={onBack}
          disabled={placementModeActive}
          size="sm"
          icon={<ArrowLeftIcon size={14} />}
          data-testid="back-button"
        >
          {t('common.actions.close')}
        </Button>
        <Button onClick={() => { setSource('toolbar'); onSave(); }} disabled={placementModeActive} size="sm" data-testid="toolbar-save-button">
          {t('common.actions.save')}
        </Button>
        {/* Import/Export stay visible but inert while the table is fullscreen
            (placement-mode visual: dimmed + grayscale). */}
        <Button
          onClick={() => { setSource('toolbar'); onImport(); }}
          disabled={placementModeActive || geometryReadOnly || dataTableFullScreen}
          size="sm"
          className={dataTableFullScreen ? 'opacity-45 grayscale' : ''}
          data-testid="toolbar-import-button"
        >
          {t('common.actions.import')}
        </Button>
        <Button
          onClick={() => { setSource('toolbar'); openDialog('export'); }}
          disabled={placementModeActive || dataTableFullScreen}
          size="sm"
          className={dataTableFullScreen ? 'opacity-45 grayscale' : ''}
          data-testid="toolbar-export-button"
        >
          {t('common.actions.export')}
        </Button>
        <div className="w-px h-6 bg-border mx-2" />
        <UndoHistoryDropdown
          mode="undo"
          disabled={placementModeActive || !canUndo}
          onSingleAction={onUndo}
          testId="toolbar-undo-button"
        >
          <span className="inline-flex items-center gap-0.5">
            {t('common.actions.undo')}
            {canUndo && !placementModeActive && (
              <span className="text-[10px] opacity-60" aria-hidden="true" data-testid="undo-chevron">
                <ChevronDownIcon size={10} />
              </span>
            )}
          </span>
        </UndoHistoryDropdown>
        <UndoHistoryDropdown
          mode="redo"
          disabled={placementModeActive || !canRedo}
          onSingleAction={onRedo}
          testId="toolbar-redo-button"
        >
          <span className="inline-flex items-center gap-0.5">
            {t('common.actions.redo')}
            {canRedo && !placementModeActive && (
              <span className="text-[10px] opacity-60" aria-hidden="true" data-testid="redo-chevron">
                <ChevronDownIcon size={10} />
              </span>
            )}
          </span>
        </UndoHistoryDropdown>
      </div>

      {/* Center - the active tool's name + duotone icon, tinted with its color
          (#51). The project name/file path live in the Project Stats panel; the
          focused section (if any) is shown in the status bar. Fullscreen table
          mode has no active map tool, so it shows the table's title instead. */}
      {dataTableFullScreen ? (
        <div className="font-medium" data-testid="toolbar-data-table-title">
          {t('dataTable.title')}
        </div>
      ) : (
        <div
          className="flex items-center gap-1.5"
          data-testid="toolbar-active-tool"
          style={{ '--o': toolAccentVar(activeTool) } as CSSProperties}
        >
          <ToolGlyph tool={activeTool} size={18} />
          <span
            className="font-medium"
            /* Mix with the theme text color so the tool-tinted label stays legible
               on light/cave toolbars (raw --o can be too pale on a light panel). */
            style={{ color: 'color-mix(in oklab, var(--o) 80%, var(--cc-text-primary))' }}
          >
            {t(TOOL_LABEL_KEYS[activeTool])}
          </span>
        </div>
      )}

      {/* Right section - tools and display menu; while the table is fullscreen,
          the table picker and a "Map view" shrink button instead. */}
      <div className="flex items-center gap-2">
        {dataTableFullScreen ? (
          <>
            <TableSelectDropdown />
            <Button
              onClick={() => { setSource('toolbar'); exitDataTableFullScreen(); }}
              size="sm"
              icon={<ShrinkIcon size={14} />}
              data-testid="toolbar-map-view-button"
            >
              {t('dataTable.fullScreen.exit')}
            </Button>
          </>
        ) : (
          <>
            <div
              className={`flex items-center gap-1 transition-opacity ${placementModeActive ? 'opacity-45 grayscale' : ''}`}
              data-testid="toolbar-tools-group"
            >
              {TOOLBAR_ITEMS.map((item, index) => {
                if (item.kind === 'separator') {
                  return <div key={`sep-${index}`} className="w-px h-6 bg-border mx-1" />;
                }
                if (item.kind === 'standalone') {
                  return (
                    <ToolButton
                      key={item.id}
                      tool={item.id}
                      active={activeTool === item.id}
                      onClick={() => setActiveTool(item.id)}
                      disabled={placementModeActive || (geometryReadOnly && isMutatingTool(item.id))}
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
                    disabled={placementModeActive || (geometryReadOnly && group.tools.every(isMutatingTool))}
                  />
                );
              })}
            </div>
            <DisplayMenu />
          </>
        )}
        <IconButton
          icon={<BugIcon />}
          onClick={() => { setSource('toolbar'); openDialog('debug'); }}
          tooltip="Debug Logs"
          aria-label="Debug Logs"
          size="sm"
          disabled={placementModeActive}
          className={placementModeActive ? 'opacity-45 grayscale' : ''}
          data-testid="toolbar-debug-button"
        />
      </div>
    </header>
  );
}

interface ToolButtonProps {
  tool: ToolType;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}

function ToolButton({ tool, active, onClick, disabled = false }: ToolButtonProps) {
  const { t } = useTranslation();
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const hoverOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPointerTypeRef = useRef('mouse');

  const config = useProjectStore((s) => s.config);
  const shortcuts = config?.shortcuts ?? defaultConfig.shortcuts;
  const shortcut = getShortcutForTool(tool, shortcuts as unknown as Record<string, string[]>);

  const handleMouseEnter = useCallback(() => {
    if (disabled) return;
    // Suppress informational flyout on touch — no hover on touch devices
    if (lastPointerTypeRef.current === 'touch') return;
    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
    if (!flyoutOpen) {
      hoverOpenTimerRef.current = setTimeout(() => {
        setFlyoutOpen(true);
      }, 300);
    }
  }, [disabled, flyoutOpen]);

  const handleMouseLeave = useCallback(() => {
    if (disabled) return;
    if (hoverOpenTimerRef.current) {
      clearTimeout(hoverOpenTimerRef.current);
      hoverOpenTimerRef.current = null;
    }
    hoverCloseTimerRef.current = setTimeout(() => {
      setFlyoutOpen(false);
    }, 150);
  }, []);

  useEffect(() => {
    return () => {
      if (hoverOpenTimerRef.current) clearTimeout(hoverOpenTimerRef.current);
      if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
    };
  }, []);

  const handleClick = useCallback(() => {
    if (disabled) return;
    setSource('toolbar');
    onClick();
    setFlyoutOpen(false);
  }, [disabled, onClick]);

  useEffect(() => {
    if (disabled && flyoutOpen) {
      setFlyoutOpen(false);
    }
  }, [disabled, flyoutOpen]);

  return (
    <div
      className="relative"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onPointerDown={(e) => { lastPointerTypeRef.current = e.pointerType; }}
    >
      <IconButton
        icon={<ToolIcon tool={tool} />}
        onClick={handleClick}
        disabled={disabled}
        aria-label={t(TOOL_LABEL_KEYS[tool])}
        size="sm"
        aria-pressed={active}
        className={`sh-tool ${active ? 'sh-tool--active' : ''}`}
        style={{ '--o': toolAccentVar(tool) } as CSSProperties}
        data-testid={`tool-${tool}`}
      />

      {flyoutOpen && !disabled && (
        <div
          className="absolute top-full right-0 mt-1 z-50 bg-panel border border-border rounded shadow-lg py-1 min-w-[10rem]"
          role="menu"
          aria-label={t(TOOL_LABEL_KEYS[tool])}
          data-testid={`subtool-flyout-${tool}`}
        >
          <button
            role="menuitem"
            className={`
              flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left
              transition-colors
              ${active ? 'bg-accent-20 text-accent' : 'text-text-primary hover:bg-border'}
            `}
            onClick={handleClick}
            tabIndex={0}
            aria-current={active ? 'true' : undefined}
            data-testid={`subtool-${tool}`}
          >
            <span className="w-5 text-center"><ToolIcon tool={tool} /></span>
            <span className="flex-1">{t(TOOL_LABEL_KEYS[tool])}</span>
            {shortcut && <span className="text-text-secondary text-xs ml-2">{shortcut}</span>}
          </button>
        </div>
      )}
    </div>
  );
}

interface ToolGroupButtonProps {
  group: ToolGroupDef;
  activeTool: ToolType;
  onActivateTool: (tool: ToolType) => void;
  disabled?: boolean;
}

function ToolGroupButton({ group, activeTool, onActivateTool, disabled = false }: ToolGroupButtonProps) {
  const { t } = useTranslation();
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const hoverOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPointerTypeRef = useRef('mouse');

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
  // Touch: toggle flyout instead of cycling (let user pick from list).
  const handleClick = useCallback(() => {
    if (disabled) return;
    // Touch tap opens/closes flyout instead of cycling
    if (lastPointerTypeRef.current === 'touch') {
      setFlyoutOpen((prev) => !prev);
      return;
    }
    setSource('toolbar');
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
    setFlyoutOpen(false);
  }, [disabled, isGroupActive, displayTool, activeTool, group.tools, onActivateTool]);

  // Right-click: Toggle flyout
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (disabled) return;
    setFlyoutOpen((prev) => !prev);
  }, [disabled]);

  // Hover: Open flyout after short delay, close after short delay (to survive gap)
  const handleMouseEnter = useCallback(() => {
    if (disabled) return;
    if (lastPointerTypeRef.current === 'touch') return;
    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
    if (!flyoutOpen) {
      hoverOpenTimerRef.current = setTimeout(() => {
        setFlyoutOpen(true);
      }, 300);
    }
  }, [disabled, flyoutOpen]);

  const handleMouseLeave = useCallback(() => {
    if (disabled) return;
    if (hoverOpenTimerRef.current) {
      clearTimeout(hoverOpenTimerRef.current);
      hoverOpenTimerRef.current = null;
    }
    hoverCloseTimerRef.current = setTimeout(() => {
      setFlyoutOpen(false);
    }, 150);
  }, [disabled]);

  // Close flyout when clicking outside
  useEffect(() => {
    if (!flyoutOpen) return;

    const handleClickOutside = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (buttonRef.current?.contains(target)) return;
      if (flyoutRef.current?.contains(target)) return;
      closeFlyout();
    };

    // Use a microtask delay to avoid the click that opened the flyout from
    // immediately closing it
    const timeoutId = setTimeout(() => {
      document.addEventListener('pointerdown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('pointerdown', handleClickOutside);
    };
  }, [flyoutOpen, closeFlyout]);

  useEffect(() => {
    if (disabled && flyoutOpen) {
      setFlyoutOpen(false);
    }
  }, [disabled, flyoutOpen]);

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

  // Cleanup hover timers on unmount
  useEffect(() => {
    return () => {
      if (hoverOpenTimerRef.current) clearTimeout(hoverOpenTimerRef.current);
      if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
    };
  }, []);

  // Keyboard handler for the flyout
  const handleFlyoutKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (disabled) return;
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
  }, [disabled, focusedIndex, group.tools, onActivateTool, closeFlyout]);

  // Handle clicking a subtool in the flyout (mouse path also restores focus)
  const handleSubtoolClick = useCallback((tool: ToolType) => {
    if (disabled) return;
    setSource('toolbar');
    onActivateTool(tool);
    closeFlyout();
  }, [disabled, onActivateTool, closeFlyout]);

  const groupLabel = t(TOOL_GROUP_LABEL_KEYS[group.id] ?? group.id);

  return (
    <div
      className="relative"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onPointerDown={(e) => { lastPointerTypeRef.current = e.pointerType; }}
    >
      <IconButton
        ref={buttonRef}
        icon={(
          <span className="relative flex items-center justify-center">
            <ToolIcon tool={displayTool} />
            <span
              className="absolute -bottom-1 -right-1 text-text-secondary pointer-events-none"
              aria-hidden="true"
            >
              <ChevronDownIcon size={8} />
            </span>
          </span>
        )}
        size="sm"
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        disabled={disabled}
        aria-label={t(TOOL_LABEL_KEYS[displayTool])}
        aria-pressed={isGroupActive}
        aria-haspopup="true"
        aria-expanded={flyoutOpen}
        className={`sh-tool ${isGroupActive ? 'sh-tool--active' : ''}`}
        style={{ '--o': toolAccentVar(displayTool) } as CSSProperties}
        data-testid={`tool-group-${group.id}`}
      />

      {flyoutOpen && !disabled && (
        <div
          ref={flyoutRef}
          className="absolute top-full right-0 mt-1 z-50 bg-panel border border-border rounded shadow-lg py-1 min-w-[10rem]"
          role="menu"
          aria-label={t('toolbar.groupAria', { group: groupLabel })}
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
                  ${isActive ? 'bg-accent-20 text-accent' : 'text-text-primary hover:bg-border'}
                  ${isFocused ? 'outline outline-2 outline-accent outline-offset-[-2px]' : ''}
                `}
                onClick={() => handleSubtoolClick(tool)}
                tabIndex={isFocused ? 0 : -1}
                aria-current={isActive ? 'true' : undefined}
                data-testid={`subtool-${tool}`}
              >
                <span className="w-5 text-center"><ToolIcon tool={tool} /></span>
                <span className="flex-1">{t(TOOL_LABEL_KEYS[tool])}</span>
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
  return (
    <span className="inline-flex items-center justify-center">
      <ToolGlyph tool={tool} size={20} />
    </span>
  );
}
