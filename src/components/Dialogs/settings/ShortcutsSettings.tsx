import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Button } from '../../common/Button';
import { ShortcutRecorder } from '../../Settings/ShortcutRecorder';
import { getPanelId, getTabId } from '../SettingsSidebar';
import type { SettingsCategoryProps } from './types';
import type { Config, ShortcutsConfig } from '../../../types/config';
import { defaultConfig } from '../../../types/config';
import {
  normalizeShortcut,
  checkReservedConflict,
  findConflict,
  formatShortcut,
  formatActionName,
  isMac,
  RESERVED_SHORTCUTS,
} from '../../../utils/shortcuts';

/**
 * Categories for organizing shortcuts in the settings UI.
 */
interface ShortcutCategory {
  id: string;
  label: string;
  actions: (keyof ShortcutsConfig)[];
}

const SHORTCUT_CATEGORIES: ShortcutCategory[] = [
  {
    id: 'file',
    label: 'File',
    actions: ['import_dmp', 'export'],
  },
  {
    id: 'tools',
    label: 'Tools',
    actions: ['select', 'pan', 'zoom', 'draw', 'delete_tool', 'merge', 'measure', 'move_section', 'move_station'],
  },
  {
    id: 'edit',
    label: 'Edit',
    actions: ['undo', 'redo', 'save'],
  },
  {
    id: 'view',
    label: 'View',
    actions: [
      'toggle_depth_gradient',
      'toggle_grid',
      'toggle_satellite',
      'toggle_station_labels',
      'toggle_shot_labels',
      'toggle_section_labels',
      'fit_to_bounds',
      'zoom_in',
      'zoom_out',
    ],
  },
  {
    id: 'panels',
    label: 'Panels',
    actions: ['toggle_sections_panel', 'toggle_detail_panel', 'toggle_data_table'],
  },
];

/**
 * Action name label with hover tooltip for truncated names.
 * Uses a custom tooltip (not native title) for keyboard accessibility and consistent styling.
 */
function ShortcutNameLabel({ name }: { name: string }) {
  const [showTooltip, setShowTooltip] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  // Check if text is actually truncated
  const checkTruncation = useCallback(() => {
    const el = containerRef.current;
    if (el) {
      setIsTruncated(el.scrollWidth > el.clientWidth);
    }
  }, []);

  return (
    <div className="relative flex-1 min-w-[8rem]">
      <div
        ref={containerRef}
        className="text-sm truncate"
        onMouseEnter={() => { checkTruncation(); setShowTooltip(true); }}
        onMouseLeave={() => setShowTooltip(false)}
        onFocus={() => { checkTruncation(); setShowTooltip(true); }}
        onBlur={() => setShowTooltip(false)}
        tabIndex={-1}
      >
        {name}
      </div>
      {showTooltip && isTruncated && (
        <div
          className="absolute left-0 bottom-full mb-1 bg-gray-900 text-white text-xs px-2 py-1 rounded whitespace-nowrap pointer-events-none z-10"
          role="tooltip"
        >
          {name}
        </div>
      )}
    </div>
  );
}

/**
 * Reserved shortcut descriptions for display.
 */
const RESERVED_SHORTCUT_DESCRIPTIONS: Record<string, string> = {
  Escape: 'Cancel / Close dialogs',
  Delete: 'Delete selection',
  Backspace: 'Delete selection',
  'Ctrl+A': 'Select all',
  'Ctrl+,': 'Open Settings',
};

/**
 * Get reserved shortcuts for display.
 */
function getReservedShortcutsForDisplay(): Array<{ shortcut: string; description: string }> {
  return Array.from(RESERVED_SHORTCUTS).map((shortcut) => ({
    shortcut,
    description: RESERVED_SHORTCUT_DESCRIPTIONS[shortcut] || 'Reserved',
  }));
}

/**
 * Shortcuts settings category content.
 * Preserves the table layout from the original SettingsDialog shortcuts tab.
 */
export function ShortcutsSettings({
  config,
  onChange,
  changedFields: _changedFields,
  onValidationError,
  panelIdBase,
}: SettingsCategoryProps) {
  const [shortcutSearch, setShortcutSearch] = useState('');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [shortcutError, setShortcutError] = useState<string | null>(null);

  // Track error state for parent
  const hasErrorRef = useRef(false);

  // Report validation error state
  useEffect(() => {
    const hasError = shortcutError !== null;
    if (hasError !== hasErrorRef.current) {
      hasErrorRef.current = hasError;
      onValidationError('shortcuts', hasError);
    }
  }, [shortcutError, onValidationError]);

  // Build registry map for conflict detection
  const shortcutRegistry = useMemo(() => {
    const registry = new Map<string, string[]>();
    const shortcuts = config.shortcuts;
    for (const category of SHORTCUT_CATEGORIES) {
      for (const action of category.actions) {
        const bindings = shortcuts[action];
        if (Array.isArray(bindings)) {
          registry.set(action, bindings);
        }
      }
    }
    return registry;
  }, [config.shortcuts]);

  // Filter actions based on search
  const filterAction = useCallback(
    (action: keyof ShortcutsConfig): boolean => {
      if (!shortcutSearch.trim()) return true;
      const search = shortcutSearch.toLowerCase();

      const actionName = formatActionName(action).toLowerCase();
      if (actionName.includes(search)) return true;

      const bindings = config.shortcuts[action];
      if (Array.isArray(bindings)) {
        for (const binding of bindings) {
          const formatted = formatShortcut(binding, isMac()).toLowerCase();
          if (formatted.includes(search)) return true;
          if (binding.toLowerCase().includes(search)) return true;
        }
      }

      return false;
    },
    [shortcutSearch, config.shortcuts]
  );

  // Toggle category collapse
  const toggleCategory = useCallback((categoryId: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  }, []);

  // Handle shortcut change
  const handleShortcutChange = useCallback(
    (action: keyof ShortcutsConfig, slot: 'primary' | 'secondary', newValue: string | null) => {
      setShortcutError(null);

      if (newValue) {
        // Check for reserved shortcut
        const reservedConflict = checkReservedConflict(newValue);
        if (reservedConflict) {
          setShortcutError(
            `"${formatShortcut(newValue, isMac())}" cannot be assigned (reserved for: ${reservedConflict.reason}).`
          );
          return;
        }

        // Check for conflicts with other actions
        const conflict = findConflict(newValue, shortcutRegistry, action);
        if (conflict) {
          setShortcutError(
            `"${formatShortcut(newValue, isMac())}" is already used by "${formatActionName(conflict)}".`
          );
          return;
        }

        // Check for intra-action duplicate
        const normalized = normalizeShortcut(newValue);
        const currentBindings = config.shortcuts[action] || [];
        const otherSlotIndex = slot === 'primary' ? 1 : 0;
        const otherSlotValue = currentBindings[otherSlotIndex];
        if (otherSlotValue && normalizeShortcut(otherSlotValue) === normalized) {
          setShortcutError(
            `"${formatShortcut(newValue, isMac())}" is already assigned to the ${
              slot === 'primary' ? 'secondary' : 'primary'
            } slot.`
          );
          return;
        }
      }

      // Update config
      const currentBindings = [...(config.shortcuts[action] || [])];
      const slotIndex = slot === 'primary' ? 0 : 1;

      if (newValue) {
        const normalized = normalizeShortcut(newValue);
        if (normalized) {
          currentBindings[slotIndex] = normalized;
        }
      } else {
        if (slotIndex < currentBindings.length) {
          currentBindings.splice(slotIndex, 1);
        }
      }

      const filteredBindings = currentBindings.filter((b) => b && b.trim());

      const newShortcuts: ShortcutsConfig = {
        ...config.shortcuts,
        [action]: filteredBindings,
      };

      onChange({ shortcuts: newShortcuts } as Partial<Config>);
    },
    [config.shortcuts, onChange, shortcutRegistry]
  );

  // Reset single action to defaults
  const handleResetAction = useCallback(
    (action: keyof ShortcutsConfig) => {
      setShortcutError(null);

      const newShortcuts: ShortcutsConfig = {
        ...config.shortcuts,
        [action]: [...defaultConfig.shortcuts[action]],
      };

      onChange({ shortcuts: newShortcuts } as Partial<Config>);
    },
    [config.shortcuts, onChange]
  );

  // Reset all shortcuts to defaults
  const handleResetAll = useCallback(() => {
    setShortcutError(null);
    onChange({ shortcuts: { ...defaultConfig.shortcuts } } as Partial<Config>);
  }, [onChange]);

  // Handle blocked key from ShortcutRecorder
  const handleBlockedKey = useCallback((key: string) => {
    setShortcutError(`"${key}" cannot be used as a shortcut.`);
  }, []);

  return (
    <div
      role="tabpanel"
      id={getPanelId(panelIdBase, 'shortcuts')}
      aria-labelledby={getTabId(panelIdBase, 'shortcuts')}
      data-testid="settings-panel-shortcuts"
    >
      <h2 className="text-lg font-medium mb-4">Shortcuts</h2>

      <div className="space-y-4" data-testid="shortcuts-tab-content">
        {/* Reserved shortcuts section (always visible, above search) */}
        <div className="mb-4">
          <h3 className="text-sm font-medium mb-2 text-text-secondary">Reserved Shortcuts</h3>
          <div
            className="bg-background/50 rounded-lg p-3 grid grid-cols-2 gap-2 text-sm"
            data-testid="reserved-shortcuts"
          >
            {getReservedShortcutsForDisplay().map(({ shortcut, description }) => (
              <div key={shortcut} className="flex items-center gap-2">
                <span className="inline-flex items-center justify-center px-1.5 py-0.5 text-xs font-medium bg-panel border border-border rounded min-w-[3rem] text-text-secondary">
                  {formatShortcut(shortcut, isMac())}
                </span>
                <span className="text-text-secondary text-xs">{description}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Search bar */}
        <div className="relative">
          <input
            type="text"
            value={shortcutSearch}
            onChange={(e) => setShortcutSearch(e.target.value)}
            placeholder="Search shortcuts..."
            aria-label="Search keyboard shortcuts"
            className="w-full px-3 py-2 pl-9 bg-background border border-border rounded text-sm"
            data-testid="shortcuts-search"
          />
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>

        {/* Error message */}
        {shortcutError && (
          <div
            role="alert"
            aria-live="assertive"
            className="p-2 bg-error/10 border border-error/30 rounded text-error text-sm"
            data-testid="shortcut-error"
          >
            {shortcutError}
          </div>
        )}

        {/* Scrollable shortcuts list */}
        <div className="max-h-[300px] overflow-y-auto space-y-4 pr-2">
          {SHORTCUT_CATEGORIES.map((category) => {
            const filteredActions = category.actions.filter(filterAction);
            if (filteredActions.length === 0) return null;

            const isCollapsed = collapsedCategories.has(category.id);

            return (
              <div key={category.id} data-testid={`shortcut-category-${category.id}`}>
                {/* Category header */}
                <button
                  type="button"
                  onClick={() => toggleCategory(category.id)}
                  className="flex items-center gap-2 w-full text-left text-sm font-medium mb-2 hover:text-accent transition-colors"
                  data-testid={`shortcut-category-toggle-${category.id}`}
                >
                  <svg
                    className={`w-4 h-4 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                  {category.label}
                </button>

                {/* Category content */}
                {!isCollapsed && (
                  <div className="space-y-0.5 pl-6">
                    {filteredActions.map((action, idx) => {
                      const bindings = config.shortcuts[action] || [];
                      const primary = bindings[0] || null;
                      const secondary = bindings[1] || null;
                      const full = formatActionName(action);
                      const hasChanges =
                        JSON.stringify(bindings) !== JSON.stringify(defaultConfig.shortcuts[action]);
                      const isOdd = idx % 2 === 1;

                      return (
                        <div
                          key={action}
                          className={`flex items-center gap-3 py-0.5 rounded ${isOdd ? 'bg-panel/20' : 'bg-transparent'}`}
                          data-testid={`shortcut-row-${action}`}
                        >
                          {/* Action name */}
                          <ShortcutNameLabel name={full} />

                          {/* Primary slot */}
                          <ShortcutRecorder
                            value={primary}
                            onChange={(value) => handleShortcutChange(action, 'primary', value)}
                            onBlockedKey={handleBlockedKey}
                            ariaLabel={`Primary shortcut for ${full}`}
                            data-testid={`shortcut-primary-${action}`}
                          />

                          {/* Secondary slot */}
                          <ShortcutRecorder
                            value={secondary}
                            onChange={(value) => handleShortcutChange(action, 'secondary', value)}
                            onBlockedKey={handleBlockedKey}
                            ariaLabel={`Secondary shortcut for ${full}`}
                            data-testid={`shortcut-secondary-${action}`}
                          />

                          {/* Reset button */}
                          <button
                            type="button"
                            onClick={() => handleResetAction(action)}
                            disabled={!hasChanges}
                            className={`p-1 rounded hover:bg-panel transition-colors ${
                              hasChanges
                                ? 'text-text-secondary hover:text-text'
                                : 'text-border cursor-not-allowed'
                            }`}
                            title="Reset to default"
                            data-testid={`shortcut-reset-${action}`}
                          >
                            <svg
                              className="w-4 h-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                              />
                            </svg>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Reset All button */}
        <div className="pt-2 border-t border-border">
          <Button variant="danger" onClick={handleResetAll} data-testid="shortcuts-reset-all">
            Reset All Shortcuts
          </Button>
        </div>
      </div>
    </div>
  );
}
