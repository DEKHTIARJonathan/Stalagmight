import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { Select } from '../common/Select';
import { DialogWrapper } from './DialogWrapper';
import { ShortcutRecorder } from '../Settings/ShortcutRecorder';
import {
  normalizeShortcut,
  checkReservedConflict,
  findConflict,
  formatShortcut,
  formatActionName,
  isMac,
  RESERVED_SHORTCUTS,
} from '../../utils/shortcuts';
import type { CacheStats } from '../../types/cache';
import type { Config, ShortcutsConfig, ShortcutFeedback } from '../../types/config';
import { defaultConfig } from '../../types/config';

interface ConfigChange {
  path: string;
  oldValue: string;
  newValue: string;
}

/**
 * Compute differences between two config objects
 * Returns a list of changed paths with old and new values
 */
function computeConfigDiff(oldConfig: Config, newConfig: Config): ConfigChange[] {
  const changes: ConfigChange[] = [];

  // Check map.station
  if (oldConfig.map.station.radius !== newConfig.map.station.radius) {
    changes.push({
      path: 'map.station.radius',
      oldValue: String(oldConfig.map.station.radius),
      newValue: String(newConfig.map.station.radius),
    });
  }
  if (oldConfig.map.station.hit_area !== newConfig.map.station.hit_area) {
    changes.push({
      path: 'map.station.hit_area',
      oldValue: String(oldConfig.map.station.hit_area),
      newValue: String(newConfig.map.station.hit_area),
    });
  }

  // Check map.shot
  if (oldConfig.map.shot.width !== newConfig.map.shot.width) {
    changes.push({
      path: 'map.shot.width',
      oldValue: String(oldConfig.map.shot.width),
      newValue: String(newConfig.map.shot.width),
    });
  }
  if (oldConfig.map.shot.hit_area !== newConfig.map.shot.hit_area) {
    changes.push({
      path: 'map.shot.hit_area',
      oldValue: String(oldConfig.map.shot.hit_area),
      newValue: String(newConfig.map.shot.hit_area),
    });
  }

  // Check map.snap
  if (oldConfig.map.snap.threshold !== newConfig.map.snap.threshold) {
    changes.push({
      path: 'map.snap.threshold',
      oldValue: String(oldConfig.map.snap.threshold),
      newValue: String(newConfig.map.snap.threshold),
    });
  }
  if (oldConfig.map.snap.enabled_draw !== newConfig.map.snap.enabled_draw) {
    changes.push({
      path: 'map.snap.enabled_draw',
      oldValue: String(oldConfig.map.snap.enabled_draw),
      newValue: String(newConfig.map.snap.enabled_draw),
    });
  }
  if (oldConfig.map.snap.enabled_merge !== newConfig.map.snap.enabled_merge) {
    changes.push({
      path: 'map.snap.enabled_merge',
      oldValue: String(oldConfig.map.snap.enabled_merge),
      newValue: String(newConfig.map.snap.enabled_merge),
    });
  }
  if (oldConfig.map.snap.enabled_measure !== newConfig.map.snap.enabled_measure) {
    changes.push({
      path: 'map.snap.enabled_measure',
      oldValue: String(oldConfig.map.snap.enabled_measure),
      newValue: String(newConfig.map.snap.enabled_measure),
    });
  }

  // Check debug.map
  if (oldConfig.debug.map.show_hitboxes !== newConfig.debug.map.show_hitboxes) {
    changes.push({
      path: 'debug.map.show_hitboxes',
      oldValue: String(oldConfig.debug.map.show_hitboxes),
      newValue: String(newConfig.debug.map.show_hitboxes),
    });
  }
  if (oldConfig.debug.map.log_hit_detection !== newConfig.debug.map.log_hit_detection) {
    changes.push({
      path: 'debug.map.log_hit_detection',
      oldValue: String(oldConfig.debug.map.log_hit_detection),
      newValue: String(newConfig.debug.map.log_hit_detection),
    });
  }

  // Check cache settings
  if (oldConfig.cache.tile_cache_enabled !== newConfig.cache.tile_cache_enabled) {
    changes.push({
      path: 'cache.tile_cache_enabled',
      oldValue: String(oldConfig.cache.tile_cache_enabled),
      newValue: String(newConfig.cache.tile_cache_enabled),
    });
  }
  if (oldConfig.cache.tile_cache_max_mb !== newConfig.cache.tile_cache_max_mb) {
    changes.push({
      path: 'cache.tile_cache_max_mb',
      oldValue: String(oldConfig.cache.tile_cache_max_mb),
      newValue: String(newConfig.cache.tile_cache_max_mb),
    });
  }

  // Check map.zoom_step
  if (oldConfig.map.zoom_step !== newConfig.map.zoom_step) {
    changes.push({
      path: 'map.zoom_step',
      oldValue: String(oldConfig.map.zoom_step),
      newValue: String(newConfig.map.zoom_step),
    });
  }

  // Check general.shortcut_feedback
  if (oldConfig.general.shortcut_feedback !== newConfig.general.shortcut_feedback) {
    changes.push({
      path: 'general.shortcut_feedback',
      oldValue: String(oldConfig.general.shortcut_feedback),
      newValue: String(newConfig.general.shortcut_feedback),
    });
  }

  return changes;
}

type SettingsTab = 'general' | 'cache' | 'shortcuts';

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
    actions: ['toggle_depth_gradient', 'toggle_grid', 'toggle_satellite', 'toggle_station_labels', 'toggle_shot_labels', 'toggle_section_labels', 'fit_to_bounds', 'zoom_in', 'zoom_out'],
  },
  {
    id: 'panels',
    label: 'Panels',
    actions: ['toggle_sections_panel', 'toggle_detail_panel', 'toggle_data_table'],
  },
];

/**
 * Reserved shortcut descriptions for display.
 * Derived from RESERVED_SHORTCUTS to avoid drift.
 */
const RESERVED_SHORTCUT_DESCRIPTIONS: Record<string, string> = {
  Escape: 'Cancel / Close dialogs',
  Delete: 'Delete selection',
  Backspace: 'Delete selection',
  'Ctrl+I': 'Import DMP',
  'Ctrl+E': 'Export',
  'Ctrl+A': 'Select all',
};

/**
 * Get reserved shortcuts for display, derived from the canonical source.
 */
function getReservedShortcutsForDisplay(): Array<{ shortcut: string; description: string }> {
  return Array.from(RESERVED_SHORTCUTS).map((shortcut) => ({
    shortcut,
    description: RESERVED_SHORTCUT_DESCRIPTIONS[shortcut] || 'Reserved',
  }));
}

/**
 * Get abbreviated action name for display (with tooltip for full name).
 */
function getAbbreviatedName(action: string): { short: string; full: string } {
  const full = formatActionName(action);
  // For longer names, abbreviate
  if (full.length > 16) {
    const words = full.split(' ');
    if (words.length >= 3) {
      // Take first letter of each word except last, plus last word
      const abbrev = words.slice(0, -1).map(w => w[0]).join('') + ' ' + words[words.length - 1];
      return { short: abbrev, full };
    }
  }
  return { short: full, full };
}

const MIN_CACHE_SIZE_MB = 100;
const MAX_CACHE_SIZE_MB = 10000;

/**
 * Format bytes to human-readable string (e.g., "12.5 MB")
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(1)} ${sizes[i]}`;
}

/**
 * Clamp a number to a range
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Props for ShortcutsTabContent component.
 */
interface ShortcutsTabContentProps {
  localConfig: Config | null;
  setLocalConfig: React.Dispatch<React.SetStateAction<Config | null>>;
  setIsDirty: React.Dispatch<React.SetStateAction<boolean>>;
  shortcutSearch: string;
  setShortcutSearch: React.Dispatch<React.SetStateAction<string>>;
  collapsedCategories: Set<string>;
  setCollapsedCategories: React.Dispatch<React.SetStateAction<Set<string>>>;
  shortcutError: string | null;
  setShortcutError: React.Dispatch<React.SetStateAction<string | null>>;
}

/**
 * Shortcuts tab content component.
 * Separated for cleaner code organization.
 */
function ShortcutsTabContent({
  localConfig,
  setLocalConfig,
  setIsDirty,
  shortcutSearch,
  setShortcutSearch,
  collapsedCategories,
  setCollapsedCategories,
  shortcutError,
  setShortcutError,
}: ShortcutsTabContentProps) {
  // Build registry map for conflict detection
  const shortcutRegistry = useMemo(() => {
    if (!localConfig) return new Map<string, string[]>();
    const registry = new Map<string, string[]>();
    const shortcuts = localConfig.shortcuts;
    for (const category of SHORTCUT_CATEGORIES) {
      for (const action of category.actions) {
        const bindings = shortcuts[action];
        if (Array.isArray(bindings)) {
          registry.set(action, bindings);
        }
      }
    }
    return registry;
  }, [localConfig]);

  // Filter actions based on search (by action name or key name)
  const filterAction = useCallback(
    (action: keyof ShortcutsConfig): boolean => {
      if (!shortcutSearch.trim()) return true;
      const search = shortcutSearch.toLowerCase();

      // Match action name
      const actionName = formatActionName(action).toLowerCase();
      if (actionName.includes(search)) return true;

      // Match key names in bindings
      if (localConfig) {
        const bindings = localConfig.shortcuts[action];
        if (Array.isArray(bindings)) {
          for (const binding of bindings) {
            const formatted = formatShortcut(binding, isMac()).toLowerCase();
            if (formatted.includes(search)) return true;
            // Also check raw binding
            if (binding.toLowerCase().includes(search)) return true;
          }
        }
      }

      return false;
    },
    [shortcutSearch, localConfig]
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
  }, [setCollapsedCategories]);

  // Handle shortcut change for an action
  const handleShortcutChange = useCallback(
    (action: keyof ShortcutsConfig, slot: 'primary' | 'secondary', newValue: string | null) => {
      if (!localConfig) return;

      setShortcutError(null);

      if (newValue) {
        // Check for reserved shortcut (broader check that matches runtime behavior)
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

        // Check for intra-action duplicate (same shortcut in both slots)
        const normalized = normalizeShortcut(newValue);
        const currentBindings = localConfig.shortcuts[action] || [];
        const otherSlotIndex = slot === 'primary' ? 1 : 0;
        const otherSlotValue = currentBindings[otherSlotIndex];
        if (otherSlotValue && normalizeShortcut(otherSlotValue) === normalized) {
          setShortcutError(
            `"${formatShortcut(newValue, isMac())}" is already assigned to the ${slot === 'primary' ? 'secondary' : 'primary'} slot.`
          );
          return;
        }
      }

      // Update config
      const currentBindings = [...(localConfig.shortcuts[action] || [])];
      const slotIndex = slot === 'primary' ? 0 : 1;

      if (newValue) {
        const normalized = normalizeShortcut(newValue);
        if (normalized) {
          currentBindings[slotIndex] = normalized;
        }
      } else {
        // Remove binding at slot
        if (slotIndex < currentBindings.length) {
          currentBindings.splice(slotIndex, 1);
        }
      }

      // Filter out empty strings
      const filteredBindings = currentBindings.filter((b) => b && b.trim());

      setLocalConfig({
        ...localConfig,
        shortcuts: {
          ...localConfig.shortcuts,
          [action]: filteredBindings,
        },
      });
      setIsDirty(true);
    },
    [localConfig, setLocalConfig, setIsDirty, shortcutRegistry, setShortcutError]
  );

  // Reset single action to defaults
  const handleResetAction = useCallback(
    (action: keyof ShortcutsConfig) => {
      if (!localConfig) return;
      setShortcutError(null);

      setLocalConfig({
        ...localConfig,
        shortcuts: {
          ...localConfig.shortcuts,
          [action]: [...defaultConfig.shortcuts[action]],
        },
      });
      setIsDirty(true);
    },
    [localConfig, setLocalConfig, setIsDirty, setShortcutError]
  );

  // Reset all shortcuts to defaults
  const handleResetAll = useCallback(() => {
    if (!localConfig) return;
    setShortcutError(null);

    setLocalConfig({
      ...localConfig,
      shortcuts: { ...defaultConfig.shortcuts },
    });
    setIsDirty(true);
  }, [localConfig, setLocalConfig, setIsDirty, setShortcutError]);

  // Handle blocked key from ShortcutRecorder
  const handleBlockedKey = useCallback(
    (key: string) => {
      setShortcutError(`"${key}" cannot be used as a shortcut.`);
    },
    [setShortcutError]
  );

  if (!localConfig) {
    return <p className="text-text-secondary">Loading configuration...</p>;
  }

  return (
    <div className="space-y-4" data-testid="shortcuts-tab-content">
      {/* Search bar */}
      <div className="relative">
        <input
          type="text"
          value={shortcutSearch}
          onChange={(e) => setShortcutSearch(e.target.value)}
          placeholder="Search shortcuts..."
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

      {/* Error message - role="alert" ensures screen readers announce conflicts */}
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

      {/* Reserved shortcuts section */}
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
                <div className="space-y-2 pl-6">
                  {filteredActions.map((action) => {
                    const bindings = localConfig.shortcuts[action] || [];
                    const primary = bindings[0] || null;
                    const secondary = bindings[1] || null;
                    const { short, full } = getAbbreviatedName(action);
                    const hasChanges =
                      JSON.stringify(bindings) !== JSON.stringify(defaultConfig.shortcuts[action]);

                    return (
                      <div
                        key={action}
                        className="flex items-center gap-3 py-1"
                        data-testid={`shortcut-row-${action}`}
                      >
                        {/* Action name */}
                        <div
                          className="w-32 text-sm truncate"
                          title={short !== full ? full : undefined}
                        >
                          {short}
                        </div>

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
                            hasChanges ? 'text-text-secondary hover:text-text' : 'text-border cursor-not-allowed'
                          }`}
                          title="Reset to default"
                          data-testid={`shortcut-reset-${action}`}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
        <Button
          variant="danger"
          onClick={handleResetAll}
          data-testid="shortcuts-reset-all"
        >
          Reset All Shortcuts
        </Button>
      </div>
    </div>
  );
}

export default function SettingsDialog() {
  const { closeDialog } = useUIStore();
  const { config, updateConfig, setConfig } = useProjectStore();
  const [activeTab, setActiveTab] = useState<SettingsTab>('cache');
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [isLoadingStats, setIsLoadingStats] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [localConfig, setLocalConfig] = useState<Config | null>(config);
  const [isDirty, setIsDirty] = useState(false);

  // Track raw input value for max cache size (allows typing intermediate values)
  const [maxSizeInput, setMaxSizeInput] = useState<string>(
    String(config?.cache?.tile_cache_max_mb ?? 500)
  );

  // Shortcuts tab state
  const [shortcutSearch, setShortcutSearch] = useState('');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [shortcutError, setShortcutError] = useState<string | null>(null);

  // Track if component is mounted to avoid state updates after unmount
  const mountedRef = useRef(true);

  // Load cache stats when Cache tab is active or on mount
  const loadCacheStats = useCallback(async () => {
    if (!mountedRef.current) return;
    setIsLoadingStats(true);
    try {
      const stats = await invoke<CacheStats>('get_cache_stats');
      if (mountedRef.current) {
        setCacheStats(stats);
      }
    } catch (error) {
      console.error('[SettingsDialog] Failed to load cache stats:', error);
      // Don't fail silently - show zero stats
      if (mountedRef.current) {
        setCacheStats({
          total_tiles: 0,
          total_bytes: 0,
          providers: {},
        });
      }
    } finally {
      if (mountedRef.current) {
        setIsLoadingStats(false);
      }
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load stats on mount and when cache tab is selected
  useEffect(() => {
    if (activeTab === 'cache') {
      loadCacheStats();
    }
  }, [activeTab, loadCacheStats]);

  // Update local config when prop changes (but don't override dirty state)
  useEffect(() => {
    if (config && !isDirty) {
      setLocalConfig(config);
      setMaxSizeInput(String(config.cache.tile_cache_max_mb));
    }
  }, [config, isDirty]);

  // Handle clearing the cache
  const handleClearCache = async () => {
    setIsClearing(true);
    try {
      await invoke('clear_tile_cache', { provider: null });
      // Refresh stats after clearing
      await loadCacheStats();
    } catch (error) {
      console.error('[SettingsDialog] Failed to clear cache:', error);
    } finally {
      if (mountedRef.current) {
        setIsClearing(false);
      }
    }
  };

  // Handle cache enabled toggle
  const handleCacheEnabledChange = (enabled: boolean) => {
    if (!localConfig) return;
    setLocalConfig({
      ...localConfig,
      cache: {
        ...localConfig.cache,
        tile_cache_enabled: enabled,
      },
    });
    setIsDirty(true);
  };

  // Handle max cache size input change (allows intermediate values while typing)
  const handleMaxSizeInputChange = (value: string) => {
    setMaxSizeInput(value);
    setIsDirty(true);
  };

  // Validate and apply max cache size on blur
  const handleMaxSizeBlur = () => {
    if (!localConfig) return;

    const parsed = Number(maxSizeInput);
    let finalValue: number;

    if (!Number.isFinite(parsed) || parsed <= 0) {
      // Invalid input - revert to current config value
      finalValue = localConfig.cache.tile_cache_max_mb;
    } else {
      // Clamp to valid range
      finalValue = clamp(Math.round(parsed), MIN_CACHE_SIZE_MB, MAX_CACHE_SIZE_MB);
    }

    // Update both input display and config
    setMaxSizeInput(String(finalValue));
    setLocalConfig({
      ...localConfig,
      cache: {
        ...localConfig.cache,
        tile_cache_max_mb: finalValue,
      },
    });
  };

  // Save settings
  const handleSave = async () => {
    if (!localConfig || !isDirty) return;

    // Ensure we have a valid max size before saving
    const parsed = Number(maxSizeInput);
    const finalMaxSize = Number.isFinite(parsed) && parsed > 0
      ? clamp(Math.round(parsed), MIN_CACHE_SIZE_MB, MAX_CACHE_SIZE_MB)
      : localConfig.cache.tile_cache_max_mb;

    const configToSave = {
      ...localConfig,
      cache: {
        ...localConfig.cache,
        tile_cache_max_mb: finalMaxSize,
      },
    };

    const result = await updateConfig(configToSave);
    if (result.success) {
      setIsDirty(false);
      closeDialog();
    }
  };

  // Reload config from disk
  const handleReloadConfig = async () => {
    if (!localConfig) return;

    setIsReloading(true);
    try {
      const newConfig = await invoke<Config>('reload_config');

      // Check if component is still mounted before updating state
      if (!mountedRef.current) return;

      const changes = computeConfigDiff(localConfig, newConfig);

      setLocalConfig(newConfig);
      setMaxSizeInput(String(newConfig.cache.tile_cache_max_mb));
      setConfig(newConfig); // Update store without persisting

      if (changes.length > 0) {
        const changeList = changes
          .map((c) => `\u2022 ${c.path}: ${c.oldValue} \u2192 ${c.newValue}`)
          .join('\n');
        alert(`Config reloaded:\n\n${changeList}`);
      } else {
        alert('Config reloaded (no monitored settings changed)');
      }
    } catch (error) {
      console.error('[SettingsDialog] Failed to reload config:', error);
      if (mountedRef.current) {
        alert(`Failed to reload config: ${error}`);
      }
    } finally {
      if (mountedRef.current) {
        setIsReloading(false);
      }
    }
  };

  // Show loading state if config hasn't loaded yet
  const configLoaded = localConfig !== null;

  return (
    <DialogWrapper
      title="Settings"
      onClose={closeDialog}
      isDirty={isDirty}
      size="lg"
      data-testid="settings-dialog"
    >
      {({ requestClose }) => (
        <>
          {/* Tab navigation */}
          <div className="flex border-b border-border mb-4">
            <button
              onClick={() => setActiveTab('general')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'general'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-text-secondary hover:text-text'
              }`}
              data-testid="settings-tab-general"
            >
              General
            </button>
            <button
              onClick={() => setActiveTab('cache')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'cache'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-text-secondary hover:text-text'
              }`}
              data-testid="settings-tab-cache"
            >
              Cache
            </button>
            <button
              onClick={() => setActiveTab('shortcuts')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'shortcuts'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-text-secondary hover:text-text'
              }`}
              data-testid="settings-tab-shortcuts"
            >
              Shortcuts
            </button>
          </div>

          {/* Tab content */}
          <div className="min-h-[300px]">
            {activeTab === 'general' && (
              <div className="space-y-6">
                {!configLoaded ? (
                  <p className="text-text-secondary">Loading configuration...</p>
                ) : (
                  <>
                    {/* Shortcut Feedback Section */}
                    <div>
                      <h3 className="text-sm font-medium mb-3">Feedback</h3>
                      <div className="space-y-4">
                        <div>
                          <label id="shortcut-feedback-label" className="block text-sm mb-1">
                            Shortcut feedback
                          </label>
                          <Select
                            value={localConfig.general.shortcut_feedback}
                            onChange={(value) => {
                              setLocalConfig({
                                ...localConfig,
                                general: {
                                  ...localConfig.general,
                                  shortcut_feedback: value as ShortcutFeedback,
                                },
                              });
                              setIsDirty(true);
                            }}
                            options={[
                              { value: 'none', label: 'None' },
                              { value: 'non_obvious', label: 'Non-obvious only' },
                              { value: 'all', label: 'All' },
                            ]}
                            className="max-w-xs"
                            aria-labelledby="shortcut-feedback-label"
                            data-testid="shortcut-feedback-select"
                          />
                          <p className="text-xs text-text-secondary mt-1">
                            Show toast notifications when keyboard shortcuts are activated
                          </p>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {activeTab === 'cache' && (
              <div className="space-y-6">
                {/* Cache Statistics Section */}
                <div>
                  <h3 className="text-sm font-medium mb-3">Tile Cache</h3>
                  <div
                    className="bg-background/50 rounded-lg p-4 space-y-3"
                    data-testid="cache-stats"
                  >
                    {isLoadingStats ? (
                      <p className="text-text-secondary">Loading cache statistics...</p>
                    ) : cacheStats ? (
                      <>
                        <div className="flex justify-between">
                          <span className="text-text-secondary">Cached tiles:</span>
                          <span data-testid="cache-tile-count">{cacheStats.total_tiles.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-text-secondary">Cache size:</span>
                          <span data-testid="cache-size">{formatBytes(cacheStats.total_bytes)}</span>
                        </div>
                        {Object.entries(cacheStats.providers).length > 0 && (
                          <div className="pt-2 border-t border-border">
                            <span className="text-xs text-text-secondary">By provider:</span>
                            {Object.entries(cacheStats.providers).map(([provider, stats]) => (
                              <div key={provider} className="flex justify-between text-sm mt-1">
                                <span className="text-text-secondary capitalize">{provider}:</span>
                                <span>{stats.tiles.toLocaleString()} tiles ({formatBytes(stats.bytes)})</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="text-text-secondary">Unable to load cache statistics</p>
                    )}
                  </div>

                  {/* Clear cache button */}
                  <div className="mt-3">
                    <Button
                      variant="danger"
                      onClick={handleClearCache}
                      disabled={isClearing || (cacheStats?.total_tiles ?? 0) === 0}
                      data-testid="clear-cache-button"
                    >
                      {isClearing ? 'Clearing...' : 'Clear Cache'}
                    </Button>
                  </div>
                </div>

                {/* Cache Configuration Section */}
                <div>
                  <h3 className="text-sm font-medium mb-3">Cache Configuration</h3>
                  {!configLoaded ? (
                    <p className="text-text-secondary">Loading configuration...</p>
                  ) : (
                    <div className="space-y-4">
                      {/* Cache enabled toggle */}
                      <label className="flex items-center gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={localConfig.cache.tile_cache_enabled}
                          onChange={(e) => handleCacheEnabledChange(e.target.checked)}
                          className="w-4 h-4 rounded border-border"
                          data-testid="cache-enabled-toggle"
                        />
                        <div>
                          <span className="block">Enable tile caching</span>
                          <span className="block text-xs text-text-secondary">
                            Cache satellite tiles for offline access
                          </span>
                        </div>
                      </label>

                      {/* Max cache size */}
                      <div>
                        <label className="block text-sm mb-1">Maximum cache size</label>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={MIN_CACHE_SIZE_MB}
                            max={MAX_CACHE_SIZE_MB}
                            step={100}
                            value={maxSizeInput}
                            onChange={(e) => handleMaxSizeInputChange(e.target.value)}
                            onBlur={handleMaxSizeBlur}
                            className="w-24 px-2 py-1 bg-background border border-border rounded text-sm"
                            data-testid="cache-max-size-input"
                          />
                          <span className="text-text-secondary">MB</span>
                        </div>
                        <p className="text-xs text-text-secondary mt-1">
                          Older tiles will be removed when this limit is reached ({MIN_CACHE_SIZE_MB}-{MAX_CACHE_SIZE_MB} MB)
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'shortcuts' && (
              <ShortcutsTabContent
                localConfig={localConfig}
                setLocalConfig={setLocalConfig}
                setIsDirty={setIsDirty}
                shortcutSearch={shortcutSearch}
                setShortcutSearch={setShortcutSearch}
                collapsedCategories={collapsedCategories}
                setCollapsedCategories={setCollapsedCategories}
                shortcutError={shortcutError}
                setShortcutError={setShortcutError}
              />
            )}
          </div>

          {/* Actions */}
          <div className="flex justify-between pt-4 mt-4 border-t border-border">
            <Button
              variant="secondary"
              onClick={handleReloadConfig}
              disabled={isDirty || !configLoaded || isReloading}
              title={isDirty ? 'Save or discard local changes first' : 'Reload config from file'}
              data-testid="reload-config-button"
            >
              {isReloading ? 'Reloading...' : 'Reload Config'}
            </Button>
            <div className="flex gap-2">
              <Button onClick={requestClose}>Cancel</Button>
              <Button
                variant="primary"
                onClick={handleSave}
                disabled={!isDirty || !configLoaded}
                data-testid="settings-save-button"
              >
                Save
              </Button>
            </div>
          </div>
        </>
      )}
    </DialogWrapper>
  );
}
