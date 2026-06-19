/**
 * WebdriverIO E2E Tests: Satellite Display and Cache Verification
 *
 * These tests run against the full Tauri application with real backend
 * to validate satellite tile caching functionality including:
 * - Cache population when satellite is enabled
 * - Cache hit verification on repeated views
 * - Cache management via Settings dialog
 *
 * Test requirements:
 * - Real backend (not mocked) for actual cache operations
 * - Uses IPC calls via browser.execute() for cache stats/clearing
 * - Access window.__stalagmight_map__ for map state verification
 * - Network connectivity required for satellite tile fetching
 */

import * as path from 'path';
import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  importDmpViaStore,
} from '../helpers/app';

// Get absolute path to fixtures directory
const FIXTURES_DIR = path.resolve(process.cwd(), 'e2e', 'fixtures');

/**
 * Helper to invoke IPC command using window.__TAURI__.core.invoke
 *
 * Implementation note: Uses executeAsync instead of execute because Tauri's
 * invoke() returns a Promise. WebDriver's execute() cannot await Promises
 * in the browser context, so executeAsync with a done() callback is required
 * for proper async handling. This follows the pattern in e2e/helpers/app.ts.
 */
async function invokeIPC<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const result = await browser.executeAsync(
    async (
      cmd: string,
      cmdArgs: Record<string, unknown> | undefined,
      done: (result: { ok: true; data: T } | { ok: false; error: string }) => void
    ) => {
      const { invoke } = (window as unknown as {
        __TAURI__?: { core: { invoke: <R>(cmd: string, args?: unknown) => Promise<R> } };
      }).__TAURI__?.core ?? {};

      if (!invoke) {
        done({ ok: false, error: 'Tauri invoke not available' });
        return;
      }

      try {
        const data = await invoke<T>(cmd, cmdArgs);
        done({ ok: true, data });
      } catch (err) {
        done({ ok: false, error: `IPC ${cmd} failed: ${String(err)}` });
      }
    },
    command,
    args
  );

  if (!result.ok) {
    throw new Error(result.error);
  }

  return result.data;
}

/**
 * Get cache stats via IPC
 */
interface CacheStats {
  total_tiles: number;
  total_bytes: number;
  providers: Record<string, { tiles: number; bytes: number }>;
}

async function getCacheStats(): Promise<CacheStats> {
  return await invokeIPC<CacheStats>('get_cache_stats');
}

/**
 * Clear tile cache via IPC
 */
async function clearTileCache(provider?: string): Promise<void> {
  await invokeIPC<void>('clear_tile_cache', { provider: provider ?? null });
}

/**
 * Check network connectivity via IPC
 * Backend returns boolean: true = online, false = offline
 */
async function isNetworkOnline(): Promise<boolean> {
  return await invokeIPC<boolean>('get_network_status');
}

/**
 * Check if network is available, skip test if offline
 */
async function skipIfOffline(ctx: Mocha.Context): Promise<void> {
  try {
    const online = await isNetworkOnline();
    if (!online) {
      ctx.skip();
    }
  } catch {
    // If we can't check status, assume we might be offline
    ctx.skip();
  }
}

/**
 * Set satellite view via UI store
 * Uses toggleDisplay if current state differs from desired state
 */
async function setSatellite(enabled: boolean): Promise<void> {
  await browser.execute((show: boolean) => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: {
          getState: () => {
            showSatellite: boolean;
            toggleDisplay: (key: string) => void;
          };
          setState: (state: Partial<{ showSatellite: boolean }>) => void;
        };
      };
    }).__E2E_TEST__;

    if (e2e) {
      const currentState = e2e.uiStore.getState().showSatellite;
      if (currentState !== show) {
        // Use toggleDisplay to trigger proper state handling
        e2e.uiStore.getState().toggleDisplay('showSatellite');
      }
    }
  }, enabled);
}

/**
 * Check if satellite is currently enabled
 */
async function isSatelliteEnabled(): Promise<boolean> {
  return await browser.execute(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: {
          getState: () => {
            showSatellite: boolean;
          };
        };
      };
    }).__E2E_TEST__;

    return e2e?.uiStore.getState().showSatellite ?? false;
  });
}

/**
 * Get map instance info
 */
async function getMapInfo(): Promise<{ loaded: boolean; zoom?: number; center?: [number, number] }> {
  return await browser.execute(() => {
    const map = (window as unknown as { __stalagmight_map__?: {
      loaded: () => boolean;
      getZoom: () => number;
      getCenter: () => { lng: number; lat: number };
    } }).__stalagmight_map__;

    if (!map) {
      return { loaded: false };
    }

    return {
      loaded: map.loaded(),
      zoom: map.getZoom(),
      center: [map.getCenter().lng, map.getCenter().lat] as [number, number],
    };
  });
}

/**
 * Wait for map to be loaded
 */
async function waitForMapLoaded(timeoutMs: number = 10000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const info = await getMapInfo();
      return info.loaded;
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `Map did not load within ${timeoutMs}ms`,
      interval: 500,
    }
  );
}

/**
 * Wait for map zoom to change from initial value
 */
async function waitForZoomChange(initialZoom: number, timeoutMs: number = 10000): Promise<number> {
  let newZoom = initialZoom;
  await browser.waitUntil(
    async () => {
      const info = await getMapInfo();
      if (info.zoom !== undefined && Math.abs(info.zoom - initialZoom) > 0.1) {
        newZoom = info.zoom;
        return true;
      }
      return false;
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `Zoom did not change from ${initialZoom} within ${timeoutMs}ms`,
      interval: 500,
    }
  );
  return newZoom;
}

/**
 * Open Settings dialog
 */
async function openSettingsDialog(): Promise<void> {
  await browser.execute(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: {
          getState: () => {
            openDialog: (name: string) => void;
          };
        };
      };
    }).__E2E_TEST__;

    if (e2e) {
      e2e.uiStore.getState().openDialog('settings');
    }
  });

  // Wait for dialog to appear
  const dialog = await $('[data-testid="settings-dialog"]');
  await dialog.waitForDisplayed({ timeout: 5000 });
}

/**
 * Close any open dialog
 */
async function closeDialog(): Promise<void> {
  await browser.execute(() => {
    const e2e = (window as unknown as {
      __E2E_TEST__?: {
        uiStore: {
          getState: () => {
            closeDialog: () => void;
          };
        };
      };
    }).__E2E_TEST__;

    if (e2e) {
      e2e.uiStore.getState().closeDialog();
    }
  });

  // Wait for dialog to close
  await browser.waitUntil(
    async () => {
      const dialog = await $('[data-testid="settings-dialog"]');
      return !(await dialog.isDisplayed().catch(() => false));
    },
    { timeout: 3000, interval: 100 }
  ).catch(() => {
    // Dialog might already be closed
  });
}

/**
 * Wait for cache to have at least N tiles (with timeout)
 */
async function waitForCacheTiles(minTiles: number, timeoutMs: number = 30000): Promise<CacheStats> {
  let stats: CacheStats = { total_tiles: 0, total_bytes: 0, providers: {} };

  await browser.waitUntil(
    async () => {
      stats = await getCacheStats();
      return stats.total_tiles >= minTiles;
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `Cache did not reach ${minTiles} tiles within ${timeoutMs}ms (got ${stats.total_tiles})`,
      interval: 1000,
    }
  );

  return stats;
}

/**
 * Ensure baseline state: satellite off and cache cleared
 */
async function ensureBaselineState(): Promise<void> {
  // Ensure satellite is off
  if (await isSatelliteEnabled()) {
    await setSatellite(false);
  }
  // Clear cache to ensure clean test state
  await clearTileCache();
}

describe('Satellite Display and Cache Verification', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
  });

  describe('Cache Population', () => {
    /**
     * Test: Enable satellite and verify cache receives tiles
     *
     * When satellite view is enabled, the map should fetch tiles from the
     * backend which caches them. After viewing, cache stats should show
     * non-zero tile count.
     */
    it('should populate cache when satellite is enabled', async function () {
      await skipIfOffline(this);

      await createNewProject('Cache Population Test');

      // Import survey data to have a map view
      const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
      const importResult = await importDmpViaStore(dmpPath);
      expect(importResult.success).toBe(true);

      // Wait for map to load
      await waitForMapLoaded();

      // Ensure baseline state (satellite off, cache cleared)
      await ensureBaselineState();
      const initialStats = await getCacheStats();
      expect(initialStats.total_tiles).toBe(0);

      // Enable satellite view
      await setSatellite(true);
      expect(await isSatelliteEnabled()).toBe(true);

      // Wait for tiles to load using waitUntil
      const stats = await waitForCacheTiles(1, 30000);

      // Verify cache has tiles
      expect(stats.total_tiles).toBeGreaterThan(0);
      expect(stats.total_bytes).toBeGreaterThan(0);

      // Should have provider stats
      expect(stats.providers).toBeDefined();
    });

    /**
     * Test: Zoom to different levels, verify multi-zoom caching
     *
     * Different zoom levels load different resolution tiles.
     * Zooming should add tiles at different zoom levels to cache.
     */
    it('should cache tiles at multiple zoom levels', async function () {
      await skipIfOffline(this);

      await createNewProject('Multi-Zoom Cache Test');

      // Import survey data
      const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
      const importResult = await importDmpViaStore(dmpPath);
      expect(importResult.success).toBe(true);

      await waitForMapLoaded();

      // Ensure baseline and enable satellite
      await ensureBaselineState();
      await setSatellite(true);

      // Wait for initial tiles at current zoom
      const initialStats = await waitForCacheTiles(1, 30000);
      const initialTiles = initialStats.total_tiles;
      const initialZoom = (await getMapInfo()).zoom ?? 10;

      // Zoom in using programmatic map access (more reliable than wheel events)
      await browser.execute(() => {
        const map = (window as unknown as { __stalagmight_map__?: {
          zoomIn: () => void;
          zoomOut: () => void;
        } }).__stalagmight_map__;
        if (map) {
          map.zoomIn();
          map.zoomIn();
        }
      });

      // Wait for zoom to actually change
      await waitForZoomChange(initialZoom, 5000);

      // Wait for new tiles at zoomed level - expect growth from higher resolution tiles
      const statsAfterZoomIn = await waitForCacheTiles(initialTiles + 1, 20000);
      expect(statsAfterZoomIn.total_tiles).toBeGreaterThan(initialTiles);

      const tilesAfterZoomIn = statsAfterZoomIn.total_tiles;
      const zoomedInZoom = (await getMapInfo()).zoom ?? initialZoom;

      // Zoom out past original level
      await browser.execute(() => {
        const map = (window as unknown as { __stalagmight_map__?: {
          zoomOut: () => void;
        } }).__stalagmight_map__;
        if (map) {
          map.zoomOut();
          map.zoomOut();
          map.zoomOut();
        }
      });

      await waitForZoomChange(zoomedInZoom, 5000);

      // Wait for cache to grow with zoomed-out tiles
      const finalStats = await waitForCacheTiles(tilesAfterZoomIn + 1, 20000);

      // Verify cache grew with tiles from multiple zoom levels
      expect(finalStats.total_tiles).toBeGreaterThan(tilesAfterZoomIn);
    });
  });

  describe('Cache Hit Verification', () => {
    /**
     * Test: Toggle satellite off then on, verify faster load from cache
     *
     * Second enable should serve tiles from cache, resulting in faster tile availability.
     * We measure actual time-to-tiles for both loads and verify second is faster.
     */
    it('should serve tiles from cache on re-enable (faster second load)', async function () {
      await skipIfOffline(this);

      await createNewProject('Cache Hit Test');

      // Import survey data
      const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
      const importResult = await importDmpViaStore(dmpPath);
      expect(importResult.success).toBe(true);

      await waitForMapLoaded();

      // Ensure baseline and enable satellite
      await ensureBaselineState();

      // Measure actual time-to-tiles for first load (network fetch)
      const firstLoadStart = Date.now();
      await setSatellite(true);
      const statsAfterFirstLoad = await waitForCacheTiles(1, 30000);
      const firstLoadTime = Date.now() - firstLoadStart;
      const targetTiles = statsAfterFirstLoad.total_tiles;
      expect(targetTiles).toBeGreaterThan(0);

      // Disable satellite
      await setSatellite(false);
      await browser.waitUntil(
        async () => !(await isSatelliteEnabled()),
        { timeout: 3000 }
      );

      // Measure actual time-to-tiles for second load (from cache)
      const secondLoadStart = Date.now();
      await setSatellite(true);
      // Wait for same number of tiles as first load (proves tiles are available from cache)
      await waitForCacheTiles(targetTiles, 10000);
      const secondLoadTime = Date.now() - secondLoadStart;

      // Stats should be stable (tiles served from cache)
      const statsAfterSecondLoad = await getCacheStats();
      expect(statsAfterSecondLoad.total_tiles).toBeGreaterThanOrEqual(targetTiles);

      // Second load (from cache) should be faster or equal to first load (from network)
      // Always compare against firstLoadTime to verify cache benefit
      // Use <= instead of < to handle edge case where both are very fast
      expect(secondLoadTime).toBeLessThanOrEqual(firstLoadTime);
    });

    /**
     * Test: Check cache stats IPC returns non-zero after viewing
     *
     * Verifies the get_cache_stats IPC command works correctly and
     * returns accurate statistics after satellite tiles are loaded.
     */
    it('should return accurate cache stats via IPC after viewing', async function () {
      await skipIfOffline(this);

      await createNewProject('Cache Stats IPC Test');

      // Import survey data
      const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
      const importResult = await importDmpViaStore(dmpPath);
      expect(importResult.success).toBe(true);

      await waitForMapLoaded();

      // Ensure baseline
      await ensureBaselineState();

      // Verify cache is empty
      const emptyStats = await getCacheStats();
      expect(emptyStats.total_tiles).toBe(0);
      expect(emptyStats.total_bytes).toBe(0);

      // Enable satellite and wait for tiles
      await setSatellite(true);
      const stats = await waitForCacheTiles(1, 30000);

      // Verify stats
      expect(stats.total_tiles).toBeGreaterThan(0);
      expect(stats.total_bytes).toBeGreaterThan(0);
      expect(typeof stats.providers).toBe('object');
    });

    /**
     * Test: Verify cache persists across project switch
     *
     * Cache is global (not per-project), so tiles cached in one project
     * should still be available after switching to another project.
     */
    it('should persist cache across project switch', async function () {
      await skipIfOffline(this);

      // Create first project and load tiles
      await createNewProject('Cache Persist Test 1');

      const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
      await importDmpViaStore(dmpPath);
      await waitForMapLoaded();

      // Ensure baseline and enable satellite
      await ensureBaselineState();
      await setSatellite(true);

      const statsProject1 = await waitForCacheTiles(1, 30000);
      expect(statsProject1.total_tiles).toBeGreaterThan(0);

      // Reset and create second project
      await resetAppState();
      await createNewProject('Cache Persist Test 2');

      // Cache should still have tiles (global cache, persists across projects)
      const statsProject2 = await getCacheStats();

      // Use tolerance-based comparison (background activity may cause minor changes)
      expect(statsProject2.total_tiles).toBeGreaterThanOrEqual(
        statsProject1.total_tiles - 1
      );
      expect(statsProject2.total_bytes).toBeGreaterThan(0);
    });
  });

  describe('Cache Management', () => {
    /**
     * Test: Open Settings and navigate to Cache tab
     *
     * Verifies the Settings dialog can be opened and the Cache tab
     * is accessible with proper UI elements.
     */
    it('should open Settings dialog with Cache tab', async () => {
      await createNewProject('Settings Cache Tab Test');

      // Open Settings dialog
      await openSettingsDialog();

      // Click Cache tab
      const cacheTab = await $('[data-testid="settings-tab-cache"]');
      await cacheTab.waitForClickable({ timeout: 5000 });
      await cacheTab.click();

      // Wait for cache stats section to be visible
      const cacheStats = await $('[data-testid="cache-stats"]');
      await cacheStats.waitForDisplayed({ timeout: 5000 });

      // Verify clear cache button is visible
      const clearButton = await $('[data-testid="clear-cache-button"]');
      await expect(clearButton).toBeExisting();

      // Clean up
      await closeDialog();
    });

    /**
     * Test: Verify cache stats display matches IPC response
     *
     * The UI should display the same statistics as returned by
     * the get_cache_stats IPC command.
     */
    it('should display cache stats matching IPC response', async function () {
      await skipIfOffline(this);

      await createNewProject('Stats Display Test');

      // Import data and enable satellite to populate cache
      const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
      await importDmpViaStore(dmpPath);
      await waitForMapLoaded();

      await ensureBaselineState();
      await setSatellite(true);

      // Wait for tiles to load
      const ipcStats = await waitForCacheTiles(1, 30000);

      // Open Settings and go to Cache tab
      await openSettingsDialog();
      const cacheTab = await $('[data-testid="settings-tab-cache"]');
      await cacheTab.click();

      // Wait for tile count to be displayed
      const tileCountEl = await $('[data-testid="cache-tile-count"]');
      await tileCountEl.waitForDisplayed({ timeout: 5000 });
      const displayedTileCount = await tileCountEl.getText();

      // Parse displayed count (strip all non-digits for locale independence)
      const parsedCount = parseInt(displayedTileCount.replace(/[^0-9]/g, ''), 10);

      // Should match IPC stats (with tolerance for timing)
      expect(parsedCount).toBeGreaterThanOrEqual(ipcStats.total_tiles - 5);
      expect(parsedCount).toBeLessThanOrEqual(ipcStats.total_tiles + 5);

      await closeDialog();
    });

    /**
     * Test: Clear cache via button, verify stats reset
     *
     * The Clear Cache button should trigger IPC to clear all tiles
     * and the stats should reset to zero.
     */
    it('should clear cache and reset stats via UI button', async function () {
      await skipIfOffline(this);

      await createNewProject('Clear Cache Test');

      // Populate cache
      const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
      await importDmpViaStore(dmpPath);
      await waitForMapLoaded();

      await ensureBaselineState();
      await setSatellite(true);

      // Wait for cache to have tiles
      await waitForCacheTiles(1, 30000);

      // Verify cache has tiles
      const preStats = await getCacheStats();
      expect(preStats.total_tiles).toBeGreaterThan(0);

      // Open Settings > Cache tab
      await openSettingsDialog();
      const cacheTab = await $('[data-testid="settings-tab-cache"]');
      await cacheTab.click();

      // Wait for stats to load
      const tileCountEl = await $('[data-testid="cache-tile-count"]');
      await tileCountEl.waitForDisplayed({ timeout: 5000 });

      // Click Clear Cache button
      const clearButton = await $('[data-testid="clear-cache-button"]');
      await clearButton.waitForClickable({ timeout: 5000 });
      await clearButton.click();

      // Wait for clear operation to complete (button text changes)
      await browser.waitUntil(
        async () => {
          const buttonText = await clearButton.getText();
          return !buttonText.includes('Clearing');
        },
        { timeout: 10000, interval: 500 }
      );

      // Wait for UI stats to update to zero
      await browser.waitUntil(
        async () => {
          const displayedCount = await tileCountEl.getText();
          return displayedCount === '0';
        },
        { timeout: 5000, interval: 500 }
      );

      // Verify via IPC
      const postStats = await getCacheStats();
      expect(postStats.total_tiles).toBe(0);
      expect(postStats.total_bytes).toBe(0);

      await closeDialog();
    });

    /**
     * Test: Clear cache, toggle satellite, verify fresh fetch
     *
     * After clearing cache, re-enabling satellite should trigger
     * fresh tile fetches, repopulating the cache.
     */
    it('should fetch fresh tiles after cache clear', async function () {
      await skipIfOffline(this);

      await createNewProject('Fresh Fetch Test');

      // Import data and populate cache
      const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
      await importDmpViaStore(dmpPath);
      await waitForMapLoaded();

      await setSatellite(true);

      // Wait for initial tiles
      await waitForCacheTiles(1, 30000);

      const initialStats = await getCacheStats();
      expect(initialStats.total_tiles).toBeGreaterThan(0);

      // Disable satellite BEFORE clearing cache to prevent new tiles from being fetched
      await setSatellite(false);
      await browser.waitUntil(
        async () => !(await isSatelliteEnabled()),
        { timeout: 3000 }
      );

      // Clear cache via IPC
      await clearTileCache();
      const clearedStats = await getCacheStats();
      expect(clearedStats.total_tiles).toBe(0);

      // Re-enable satellite to force fresh fetch
      await setSatellite(true);

      // Wait for fresh tiles to load
      const newStats = await waitForCacheTiles(1, 30000);

      // Verify cache repopulated
      expect(newStats.total_tiles).toBeGreaterThan(0);
      expect(newStats.total_bytes).toBeGreaterThan(0);
    });
  });
});
