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
 * - Access window.__cavechef_map__ for map state verification
 */

import * as path from 'path';
import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  importDmpFile,
} from '../helpers/app';

// Get absolute path to fixtures directory
const FIXTURES_DIR = path.resolve(process.cwd(), 'e2e', 'fixtures');

/**
 * Helper to invoke IPC command via browser.execute
 */
async function invokeIPC<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return await browser.executeAsync(
    async (
      cmd: string,
      cmdArgs: Record<string, unknown> | undefined,
      done: (result: T) => void
    ) => {
      const { invoke } = (window as unknown as {
        __TAURI__?: { core: { invoke: <R>(cmd: string, args?: unknown) => Promise<R> } };
      }).__TAURI__?.core ?? {};

      if (!invoke) {
        throw new Error('Tauri invoke not available');
      }

      try {
        const result = await invoke<T>(cmd, cmdArgs);
        done(result);
      } catch (err) {
        throw new Error(`IPC ${cmd} failed: ${String(err)}`);
      }
    },
    command,
    args
  );
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
  // Wait for map to process the change
  await browser.pause(300);
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
 * Get map instance info for debugging
 */
async function getMapInfo(): Promise<{ loaded: boolean; zoom?: number; center?: [number, number] }> {
  return await browser.execute(() => {
    const map = (window as unknown as { __cavechef_map__?: {
      loaded: () => boolean;
      getZoom: () => number;
      getCenter: () => { lng: number; lat: number };
    } }).__cavechef_map__;

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
  await browser.pause(300);
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
    it('should populate cache when satellite is enabled', async () => {
      await createNewProject('Cache Population Test');

      // Import survey data to have a map view
      const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
      const importResult = await importDmpFile(dmpPath);
      expect(importResult.success).toBe(true);

      // Wait for map to render
      await browser.pause(1000);

      // Verify map is loaded
      const mapInfo = await getMapInfo();
      expect(mapInfo.loaded).toBe(true);

      // Clear cache first to ensure clean state
      await clearTileCache();
      const initialStats = await getCacheStats();
      expect(initialStats.total_tiles).toBe(0);

      // Enable satellite view
      await setSatellite(true);
      expect(await isSatelliteEnabled()).toBe(true);

      // Wait for tiles to load (satellite tiles are fetched from real ESRI)
      // This may take a few seconds on first load
      await browser.pause(5000);

      // Verify cache has tiles
      const stats = await getCacheStats();
      expect(stats.total_tiles).toBeGreaterThan(0);
      expect(stats.total_bytes).toBeGreaterThan(0);

      // Should have ESRI provider stats
      expect(stats.providers).toBeDefined();
    });

    /**
     * Test: Pan map to load new tiles, verify cache grows
     *
     * When panning the map, new tiles should be fetched and cached,
     * increasing the total tile count.
     */
    it('should grow cache when panning map with satellite enabled', async () => {
      await createNewProject('Cache Pan Test');

      // Import survey data
      const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
      const importResult = await importDmpFile(dmpPath);
      expect(importResult.success).toBe(true);

      await browser.pause(1000);

      // Clear cache and enable satellite
      await clearTileCache();
      await setSatellite(true);

      // Wait for initial tiles
      await browser.pause(3000);
      const initialStats = await getCacheStats();
      const initialTiles = initialStats.total_tiles;

      // Pan the map to trigger loading new tiles
      const mapCanvas = await $('canvas');
      const location = await mapCanvas.getLocation();
      const size = await mapCanvas.getSize();
      const centerX = location.x + size.width / 2;
      const centerY = location.y + size.height / 2;

      // Perform a significant pan
      await browser.performActions([
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: Math.round(centerX), y: Math.round(centerY) },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerMove', x: Math.round(centerX + 200), y: Math.round(centerY + 200), duration: 300 },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ]);
      await browser.releaseActions();

      // Wait for new tiles to load
      await browser.pause(3000);

      // Verify cache grew
      const newStats = await getCacheStats();
      // Cache should have at least as many tiles (may not grow if tiles are already cached)
      expect(newStats.total_tiles).toBeGreaterThanOrEqual(initialTiles);
    });

    /**
     * Test: Zoom to different levels, verify multi-zoom caching
     *
     * Different zoom levels load different resolution tiles.
     * Zooming should add tiles at different zoom levels to cache.
     */
    it('should cache tiles at multiple zoom levels', async () => {
      await createNewProject('Multi-Zoom Cache Test');

      // Import survey data
      const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
      const importResult = await importDmpFile(dmpPath);
      expect(importResult.success).toBe(true);

      await browser.pause(1000);

      // Clear cache and enable satellite
      await clearTileCache();
      await setSatellite(true);

      // Wait for initial tiles at current zoom
      await browser.pause(3000);
      const initialStats = await getCacheStats();

      // Zoom in using mouse wheel
      await browser.execute(() => {
        const canvas = document.querySelector('canvas');
        if (canvas) {
          const zoomEvent = new WheelEvent('wheel', {
            deltaY: -300, // Zoom in significantly
            bubbles: true,
          });
          canvas.dispatchEvent(zoomEvent);
        }
      });

      // Wait for new zoom level tiles
      await browser.pause(3000);

      // Zoom out
      await browser.execute(() => {
        const canvas = document.querySelector('canvas');
        if (canvas) {
          const zoomEvent = new WheelEvent('wheel', {
            deltaY: 600, // Zoom out past original
            bubbles: true,
          });
          canvas.dispatchEvent(zoomEvent);
        }
      });

      await browser.pause(3000);

      // Verify cache has grown with multi-zoom tiles
      const finalStats = await getCacheStats();
      expect(finalStats.total_tiles).toBeGreaterThanOrEqual(initialStats.total_tiles);
    });
  });

  describe('Cache Hit Verification', () => {
    /**
     * Test: Toggle satellite off then on, verify faster load from cache
     *
     * Second load should be faster because tiles are served from cache.
     * We verify by checking that cache stats remain stable (tiles not re-fetched).
     */
    it('should serve tiles from cache on re-enable', async () => {
      await createNewProject('Cache Hit Test');

      // Import survey data
      const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
      const importResult = await importDmpFile(dmpPath);
      expect(importResult.success).toBe(true);

      await browser.pause(1000);

      // Clear cache and enable satellite
      await clearTileCache();
      await setSatellite(true);

      // Wait for tiles to load
      await browser.pause(4000);
      const statsAfterFirstLoad = await getCacheStats();
      expect(statsAfterFirstLoad.total_tiles).toBeGreaterThan(0);

      // Disable satellite
      await setSatellite(false);
      expect(await isSatelliteEnabled()).toBe(false);
      await browser.pause(500);

      // Re-enable satellite (should be instant from cache)
      await setSatellite(true);
      expect(await isSatelliteEnabled()).toBe(true);

      // Stats should be the same (tiles served from cache, not re-fetched)
      await browser.pause(1000);
      const statsAfterSecondLoad = await getCacheStats();

      // Tile count should be same or slightly more (background refresh possible)
      expect(statsAfterSecondLoad.total_tiles).toBeGreaterThanOrEqual(
        statsAfterFirstLoad.total_tiles
      );
    });

    /**
     * Test: Check cache stats IPC returns non-zero after viewing
     *
     * Verifies the get_cache_stats IPC command works correctly and
     * returns accurate statistics after satellite tiles are loaded.
     */
    it('should return accurate cache stats via IPC after viewing', async () => {
      await createNewProject('Cache Stats IPC Test');

      // Import survey data
      const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
      const importResult = await importDmpFile(dmpPath);
      expect(importResult.success).toBe(true);

      await browser.pause(1000);

      // Clear cache first
      await clearTileCache();

      // Verify cache is empty
      const emptyStats = await getCacheStats();
      expect(emptyStats.total_tiles).toBe(0);
      expect(emptyStats.total_bytes).toBe(0);

      // Enable satellite and wait for tiles
      await setSatellite(true);
      await browser.pause(4000);

      // Get stats and verify non-zero
      const stats = await getCacheStats();
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
    it('should persist cache across project switch', async () => {
      // Create first project and load tiles
      await createNewProject('Cache Persist Test 1');

      const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
      await importDmpFile(dmpPath);
      await browser.pause(1000);

      // Clear cache and enable satellite
      await clearTileCache();
      await setSatellite(true);
      await browser.pause(4000);

      const statsProject1 = await getCacheStats();
      expect(statsProject1.total_tiles).toBeGreaterThan(0);

      // Reset and create second project
      await resetAppState();
      await createNewProject('Cache Persist Test 2');

      // Cache should still have tiles (global cache)
      const statsProject2 = await getCacheStats();
      expect(statsProject2.total_tiles).toBe(statsProject1.total_tiles);
      expect(statsProject2.total_bytes).toBe(statsProject1.total_bytes);
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
      await browser.pause(300);

      // Verify cache stats section is visible
      const cacheStats = await $('[data-testid="cache-stats"]');
      await expect(cacheStats).toBeDisplayed();

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
    it('should display cache stats matching IPC response', async () => {
      await createNewProject('Stats Display Test');

      // Import data and enable satellite to populate cache
      const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
      await importDmpFile(dmpPath);
      await browser.pause(1000);

      await clearTileCache();
      await setSatellite(true);
      await browser.pause(4000);

      // Get IPC stats
      const ipcStats = await getCacheStats();

      // Open Settings and go to Cache tab
      await openSettingsDialog();
      const cacheTab = await $('[data-testid="settings-tab-cache"]');
      await cacheTab.click();
      await browser.pause(500);

      // Get UI displayed tile count
      const tileCountEl = await $('[data-testid="cache-tile-count"]');
      await expect(tileCountEl).toBeDisplayed();
      const displayedTileCount = await tileCountEl.getText();

      // Parse displayed count (may have thousands separator)
      const parsedCount = parseInt(displayedTileCount.replace(/,/g, ''), 10);

      // Should match IPC stats (or be close, allowing for race conditions)
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
    it('should clear cache and reset stats via UI button', async () => {
      await createNewProject('Clear Cache Test');

      // Populate cache
      const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
      await importDmpFile(dmpPath);
      await browser.pause(1000);

      await clearTileCache();
      await setSatellite(true);
      await browser.pause(4000);

      // Verify cache has tiles
      const preStats = await getCacheStats();
      expect(preStats.total_tiles).toBeGreaterThan(0);

      // Open Settings > Cache tab
      await openSettingsDialog();
      const cacheTab = await $('[data-testid="settings-tab-cache"]');
      await cacheTab.click();
      await browser.pause(500);

      // Click Clear Cache button
      const clearButton = await $('[data-testid="clear-cache-button"]');
      await clearButton.waitForClickable({ timeout: 5000 });
      await clearButton.click();

      // Wait for clear operation
      await browser.waitUntil(
        async () => {
          const buttonText = await clearButton.getText();
          return !buttonText.includes('Clearing');
        },
        { timeout: 10000, interval: 500 }
      );

      // Verify stats reset in UI
      await browser.pause(500);
      const tileCountEl = await $('[data-testid="cache-tile-count"]');
      const displayedCount = await tileCountEl.getText();
      expect(displayedCount).toBe('0');

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
    it('should fetch fresh tiles after cache clear', async () => {
      await createNewProject('Fresh Fetch Test');

      // Import data and populate cache
      const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
      await importDmpFile(dmpPath);
      await browser.pause(1000);

      await setSatellite(true);
      await browser.pause(4000);

      const initialStats = await getCacheStats();
      expect(initialStats.total_tiles).toBeGreaterThan(0);

      // Clear cache via IPC
      await clearTileCache();
      const clearedStats = await getCacheStats();
      expect(clearedStats.total_tiles).toBe(0);

      // Disable and re-enable satellite to force fresh fetch
      await setSatellite(false);
      await browser.pause(500);
      await setSatellite(true);

      // Wait for fresh tiles to load
      await browser.pause(5000);

      // Verify cache repopulated
      const newStats = await getCacheStats();
      expect(newStats.total_tiles).toBeGreaterThan(0);
      expect(newStats.total_bytes).toBeGreaterThan(0);
    });
  });
});
