import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Toggle } from '../../common/Toggle';
import { Button } from '../../common/Button';
import { SettingsSection } from './SettingsSection';
import { SettingRow } from './SettingRow';
import { getPanelId, getTabId } from '../SettingsSidebar';
import type { SettingsCategoryProps } from './types';
import { isFieldChanged } from './types';
import type { CacheStats } from '../../../types/cache';

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
 * Cache settings category content.
 * Maps to config.cache: tile_cache_enabled, tile_cache_max_mb, tile_ttl_days.
 * Also displays cache statistics and clear button with preserved data-testid attributes.
 */
export function CacheSettings({
  config,
  onChange,
  changedFields,
  onValidationError,
  panelIdBase,
}: SettingsCategoryProps) {
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [isLoadingStats, setIsLoadingStats] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [maxSizeInput, setMaxSizeInput] = useState<string>(String(config.cache.tile_cache_max_mb));
  const mountedRef = useRef(true);

  // Validation state
  const hasErrorRef = useRef(false);

  // Validate on mount and when config changes
  useEffect(() => {
    const errors: string[] = [];

    // Validate cache size
    if (config.cache.tile_cache_max_mb < MIN_CACHE_SIZE_MB) {
      errors.push(`Cache size must be at least ${MIN_CACHE_SIZE_MB} MB`);
    }
    if (config.cache.tile_cache_max_mb > MAX_CACHE_SIZE_MB) {
      errors.push(`Cache size must not exceed ${MAX_CACHE_SIZE_MB} MB`);
    }

    // Validate TTL
    if (config.cache.tile_ttl_days < 1 || config.cache.tile_ttl_days > 365) {
      errors.push('Cache TTL must be between 1 and 365 days');
    }

    const hasError = errors.length > 0;
    if (hasError !== hasErrorRef.current) {
      hasErrorRef.current = hasError;
      onValidationError('cache', hasError);
    }
  }, [config.cache, onValidationError]);

  // Sync maxSizeInput when config changes externally
  useEffect(() => {
    setMaxSizeInput(String(config.cache.tile_cache_max_mb));
  }, [config.cache.tile_cache_max_mb]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load cache stats
  const loadCacheStats = useCallback(async () => {
    if (!mountedRef.current) return;
    setIsLoadingStats(true);
    try {
      const stats = await invoke<CacheStats>('get_cache_stats');
      if (mountedRef.current) {
        setCacheStats(stats);
      }
    } catch (error) {
      console.error('[CacheSettings] Failed to load cache stats:', error);
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

  // Load stats on mount
  useEffect(() => {
    loadCacheStats();
  }, [loadCacheStats]);

  // Handle clearing the cache
  const handleClearCache = async () => {
    setIsClearing(true);
    try {
      await invoke('clear_tile_cache', { provider: null });
      await loadCacheStats();
    } catch (error) {
      console.error('[CacheSettings] Failed to clear cache:', error);
    } finally {
      if (mountedRef.current) {
        setIsClearing(false);
      }
    }
  };

  const handleCacheEnabledChange = (checked: boolean) => {
    onChange({
      cache: {
        ...config.cache,
        tile_cache_enabled: checked,
      },
    });
  };

  const handleMaxSizeInputChange = (value: string) => {
    setMaxSizeInput(value);
    // Immediately update config (validation will highlight errors)
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      onChange({
        cache: {
          ...config.cache,
          tile_cache_max_mb: Math.round(parsed),
        },
      });
    }
  };

  const handleMaxSizeBlur = () => {
    const parsed = Number(maxSizeInput);
    let finalValue: number;

    if (!Number.isFinite(parsed) || parsed <= 0) {
      finalValue = config.cache.tile_cache_max_mb;
    } else {
      finalValue = clamp(Math.round(parsed), MIN_CACHE_SIZE_MB, MAX_CACHE_SIZE_MB);
    }

    setMaxSizeInput(String(finalValue));
    onChange({
      cache: {
        ...config.cache,
        tile_cache_max_mb: finalValue,
      },
    });
  };

  const handleTtlChange = (value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      onChange({
        cache: {
          ...config.cache,
          tile_ttl_days: num,
        },
      });
    }
  };

  return (
    <div
      role="tabpanel"
      id={getPanelId(panelIdBase, 'cache')}
      aria-labelledby={getTabId(panelIdBase, 'cache')}
      data-testid="settings-panel-cache"
    >
      <h2 className="text-lg font-medium mb-4">Cache</h2>

      <SettingsSection title="Tile Cache" data-testid="section-tile-cache">
        {/* Cache Statistics - Preserve data-testid="cache-stats" */}
        <div
          className="bg-background/50 rounded-lg p-4 space-y-3 mb-4"
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
                      <span>
                        {stats.tiles.toLocaleString()} tiles ({formatBytes(stats.bytes)})
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="text-text-secondary">Unable to load cache statistics</p>
          )}
        </div>

        {/* Clear cache button - Preserve data-testid="clear-cache-button" */}
        <div className="mb-4">
          <Button
            variant="danger"
            onClick={handleClearCache}
            disabled={isClearing || (cacheStats?.total_tiles ?? 0) === 0}
            data-testid="clear-cache-button"
          >
            {isClearing ? 'Clearing...' : 'Clear Cache'}
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection title="Cache Configuration" data-testid="section-cache-config">
        <SettingRow
          label="Enable tile caching"
          helpText="Cache satellite tiles for offline access"
          isChanged={isFieldChanged(changedFields, 'cache.tile_cache_enabled')}
          data-testid="setting-cache-enabled"
        >
          <Toggle
            checked={config.cache.tile_cache_enabled}
            onChange={handleCacheEnabledChange}
            aria-label="Enable tile caching"
            data-testid="cache-enabled-toggle"
          />
        </SettingRow>

        <SettingRow
          label="Maximum cache size"
          helpText={`Older tiles will be removed when this limit is reached (${MIN_CACHE_SIZE_MB}-${MAX_CACHE_SIZE_MB} MB)`}
          isChanged={isFieldChanged(changedFields, 'cache.tile_cache_max_mb')}
          data-testid="setting-cache-max-size"
        >
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={MIN_CACHE_SIZE_MB}
              max={MAX_CACHE_SIZE_MB}
              step={100}
              value={maxSizeInput}
              onChange={(e) => handleMaxSizeInputChange(e.target.value)}
              onBlur={handleMaxSizeBlur}
              className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
              aria-label="Maximum cache size in MB"
              data-testid="cache-max-size-input"
            />
            <span className="text-text-secondary">MB</span>
          </div>
        </SettingRow>

        <SettingRow
          label="Cache TTL"
          helpText="How long to keep cached tiles before refreshing (1-365 days)"
          isChanged={isFieldChanged(changedFields, 'cache.tile_ttl_days')}
          data-testid="setting-cache-ttl"
        >
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={365}
              value={config.cache.tile_ttl_days}
              onChange={(e) => handleTtlChange(e.target.value)}
              className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
              aria-label="Cache TTL in days"
              data-testid="input-cache-ttl"
            />
            <span className="text-text-secondary">days</span>
          </div>
        </SettingRow>
      </SettingsSection>
    </div>
  );
}
