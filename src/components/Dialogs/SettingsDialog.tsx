import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type { CacheStats } from '../../types/cache';
import type { Config } from '../../types/config';

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

  return changes;
}

type SettingsTab = 'general' | 'cache';

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
      const changes = computeConfigDiff(localConfig, newConfig);

      setLocalConfig(newConfig);
      setMaxSizeInput(String(newConfig.cache.tile_cache_max_mb));
      setConfig(newConfig); // Update store without persisting

      if (!mountedRef.current) return;

      if (changes.length > 0) {
        const changeList = changes
          .map((c) => `- ${c.path}: ${c.oldValue} -> ${c.newValue}`)
          .join('\n');
        alert(`Config reloaded:\n\n${changeList}`);
      } else {
        alert('Config reloaded (no changes)');
      }
    } catch (error) {
      console.error('[SettingsDialog] Failed to reload config:', error);
      alert(`Failed to reload config: ${error}`);
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
          </div>

          {/* Tab content */}
          <div className="min-h-[300px]">
            {activeTab === 'general' && (
              <div className="space-y-4">
                <p className="text-text-secondary">General settings will be available here.</p>
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
