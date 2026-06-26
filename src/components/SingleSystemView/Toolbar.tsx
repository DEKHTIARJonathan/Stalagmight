import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore, type ToolType } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button, IconButton } from '../common/Button';
import {
  ChevronDownIcon,
  DownloadIcon,
  ShrinkIcon,
} from '../common/icons';
import { AppMenu, type AppMenuItem } from '../common/AppMenu';
import { useDismissableLayer } from '../../hooks/useDismissableLayer';
import { syntacticLevelAtLeast } from '../../theme/syntacticPalette';
import { ToolGlyph, toolAccentVar } from '../common/toolIcons';
import type { CSSProperties } from 'react';
import DisplayMenu from './DisplayMenu';
import { ModeCarousel } from './ModeCarousel';
import TableSelectDropdown from './TableSelectDropdown';
import UndoHistoryDropdown from './UndoHistoryDropdown';
import { TOOL_GROUPS, type ToolGroupDef } from '../../utils/toolGroups';
import { isMutatingTool } from '../../utils/toolUtils';
import { setSource } from '../../utils/telemetry';
import { defaultConfig } from '../../types/config';

interface ToolbarProps {
  /** Items for the left-side hamburger (AppMenu): file/project actions. */
  menuItems: AppMenuItem[];
  /** A save failed — tint the hamburger icon red. */
  saveFailed?: boolean;
  onImport: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  placementModeActive: boolean;
  /** Reduced variant while the data table is fullscreen: the left slot shows the
   *  "Back to Map" button instead of the Import button; the hamburger + Undo/Redo
   *  stay, and the map tools give way to the table picker. */
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
  menuItems,
  saveFailed = false,
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
  const exitDataTableFullScreen = useUIStore((s) => s.exitDataTableFullScreen);
  const appMode = useUIStore((s) => s.appMode);
  // Toolbar icons appear at the 'toolbar_only' syntactic level and up; the
  // `--sh-*` color vars are the role colors there and a neutral gray at 'off'.
  const syntacticLevel = useUIStore((s) => s.syntacticLevel);
  const showToolbarIcons = syntacticLevelAtLeast(syntacticLevel, 'toolbar_only');
  // Read-only both in the closure-adjusted view AND in Plan/Export (the whole map is
  // non-editable there) — disable the geometry-mutating tools in both. Select/Pan/Zoom/
  // Measure stay enabled, so they remain available in every mode.
  const geometryReadOnly = useUIStore(
    (s) => s.geometryMode === 'closureAdjusted' || s.appMode !== 'survey'
  );

  return (
    <header className="relative flex items-center justify-between px-4 py-2 border-b border-border bg-panel" data-testid="toolbar">
      {/* Left section: hamburger menu, Import, then Undo/Redo */}
      <div
        className={`flex items-center gap-2 transition-opacity ${placementModeActive ? 'opacity-45 grayscale' : ''}`}
        data-testid="toolbar-file-controls"
      >
        {/* Disabled during placement mode so the file/project actions that moved
            into this menu (Save/Save As/Close/New/Open/Export) stay blocked, as
            they were when they lived in the now-disabled toolbar buttons. */}
        <AppMenu
          items={menuItems}
          triggerDanger={saveFailed}
          disabled={placementModeActive}
          aria-label={t('singleView.menu.aria')}
        />
        {/* In fullscreen table mode the left slot shows the "Back to Map" button
            (the relabeled shrink button) instead of Import; both Save/Export/Close
            live in the hamburger now. */}
        {dataTableFullScreen ? (
          <Button
            icon={
              <span style={{ color: 'var(--o)' } as CSSProperties}>
                <ShrinkIcon size={16} />
              </span>
            }
            onClick={() => { setSource('toolbar'); exitDataTableFullScreen(); }}
            size="sm"
            className="sh-tool ml-1"
            style={{ '--o': toolAccentVar('pan') } as CSSProperties}
            data-testid="toolbar-map-view-button"
          >
            {t('dataTable.fullScreen.exit')}
          </Button>
        ) : (
          <Button
            onClick={() => onImport()}
            disabled={placementModeActive || geometryReadOnly}
            size="sm"
            className="ml-1"
            icon={showToolbarIcons ? <span style={{ color: 'var(--sh-comment)' }}><DownloadIcon size={18} /></span> : undefined}
            data-testid="toolbar-import-button"
          >
            {t('common.actions.import')}
          </Button>
        )}
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

      {/* Center - the Survey/Plan/Export workspace carousel (#38, Daniel's reframe).
          The active map *tool* is already shown by the highlighted toolbar button on
          the right, so the center is free for the mode switch. Fullscreen table mode
          (a survey sub-state) shows the table's title instead. */}
      {dataTableFullScreen ? (
        /* Absolutely centered: justify-between would drift the title by the
           side blocks' width difference, visibly off against the centered
           sub-header pill below. */
        <div
          className="absolute left-1/2 -translate-x-1/2 font-medium"
          data-testid="toolbar-data-table-title"
        >
          {t('dataTable.title')}
        </div>
      ) : (
        <ModeCarousel />
      )}

      {/* Right section - tools and display menu; while the table is fullscreen,
          just the table picker (the "Back to Map" button lives on the left). */}
      <div className="flex items-center gap-2">
        {dataTableFullScreen ? (
          /* The "Back to Map" shrink button now lives on the left (in place of
             the project-close button); only the table picker stays on the right. */
          <TableSelectDropdown />
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
            {/* DisplayMenu (color overlays + the geometry measured/adjusted toggle) is
                a survey concern — Plan/Export are read-only focused modes that force the
                closure map, so it's hidden there (and the geometry toggle stays locked). */}
            {appMode === 'survey' && <DisplayMenu />}
          </>
        )}
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

  // Close the flyout on outside mousedown / external scroll / resize via the
  // shared hook (the trigger button and the flyout surface are the "inside"
  // elements). The hook binds once when the flyout opens; since it listens on
  // mousedown, the interaction that opened the flyout has already completed, so
  // there's no need for the old microtask-deferred listener attach.
  useDismissableLayer({
    open: flyoutOpen,
    onDismiss: closeFlyout,
    contains: [buttonRef, flyoutRef],
  });

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
