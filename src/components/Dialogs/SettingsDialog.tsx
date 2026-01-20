import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type { CacheStats } from '../../types/cache';
import type { Config } from '../../types/config';

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
  const { config, updateConfig } = useProjectStore();
  const [activeTab, setActiveTab] = useState<SettingsTab>('cache');
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [isLoadingStats, setIsLoadingStats] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [localConfig, setLocalConfig] = useState<Config | null>(config);
  const [isDirty, setIsDirty] = useState(false);

  // Track if component is mounted to avoid state updates after unmount
  const mountedRef = useRef(true);

  // Track if we need to handle dirty state on cancel
  const handleRequestClose = useCallback(() => {
    // DialogWrapper handles the dirty confirmation, so we just call closeDialog
    // The isDirty prop passed to DialogWrapper will trigger the confirm flow
    closeDialog();
  }, [closeDialog]);

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

  // Handle max cache size change with validation and clamping
  const handleMaxSizeChange = (value: string) => {
    if (!localConfig) return;

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      // Invalid input - don't update
      return;
    }

    const clamped = clamp(Math.round(parsed), MIN_CACHE_SIZE_MB, MAX_CACHE_SIZE_MB);

    setLocalConfig({
      ...localConfig,
      cache: {
        ...localConfig.cache,
        tile_cache_max_mb: clamped,
      },
    });
    setIsDirty(true);
  };

  // Save settings
  const handleSave = async () => {
    if (!localConfig || !isDirty) return;
    const result = await updateConfig(localConfig);
    if (result.success) {
      setIsDirty(false);
      closeDialog();
    }
  };

  // Show loading state if config hasn't loaded yet
  const configLoaded = localConfig !== null;

  return (
    <DialogWrapper
      title="Settings"
      onClose={handleRequestClose}
      isDirty={isDirty}
      size="lg"
      data-testid="settings-dialog"
    >
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
                        value={localConfig.cache.tile_cache_max_mb}
                        onChange={(e) => handleMaxSizeChange(e.target.value)}
                        onBlur={(e) => {
                          // Ensure value is clamped on blur
                          const val = Number(e.target.value);
                          if (Number.isFinite(val)) {
                            const clamped = clamp(Math.round(val), MIN_CACHE_SIZE_MB, MAX_CACHE_SIZE_MB);
                            if (clamped !== val) {
                              handleMaxSizeChange(String(clamped));
                            }
                          }
                        }}
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
      <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-border">
        <Button onClick={handleRequestClose}>Cancel</Button>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={!isDirty || !configLoaded}
          data-testid="settings-save-button"
        >
          Save
        </Button>
      </div>
    </DialogWrapper>
  );
}
