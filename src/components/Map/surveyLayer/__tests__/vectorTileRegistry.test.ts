import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VectorTileSource } from 'maplibre-gl';

const maplibreMocks = vi.hoisted(() => ({ addProtocol: vi.fn() }));

vi.mock('maplibre-gl', () => ({ addProtocol: maplibreMocks.addProtocol }));

import {
  clearVtLayerData,
  decideReload,
  ensureVtProtocol,
  reloadVtSource,
  setVtLayerData,
  vtTileUrl,
} from '../vectorTileRegistry';
import { vtPointsFromFeatures } from '../vectorTileData';

function pointsAt(coords: Array<[number, number]>): GeoJSON.Feature[] {
  return coords.map(([lng, lat], i) => ({
    type: 'Feature' as const,
    geometry: { type: 'Point' as const, coordinates: [lng, lat] },
    properties: { featureId: i + 1 },
  }));
}

const data = vtPointsFromFeatures(pointsAt([[0, 0]]));

type ProtocolHandler = (params: { url: string }) => Promise<{ data: ArrayBuffer }>;
let handler: ProtocolHandler;

beforeAll(() => {
  ensureVtProtocol();
  ensureVtProtocol();
  expect(maplibreMocks.addProtocol).toHaveBeenCalledTimes(1);
  handler = maplibreMocks.addProtocol.mock.calls[0]![1] as ProtocolHandler;
});

function tileUrl(key: string, version: number): string {
  return vtTileUrl(key, version)
    .replace('{z}', '0')
    .replace('{x}', '0')
    .replace('{y}', '0');
}

describe('vector tile registry', () => {
  it('queues resident replacement behind an active load without aborting it', async () => {
    const clearTiles = vi.fn();
    const abort = vi.fn();
    const actor = {};
    const controller = { abort };
    const tile: {
      actor: object;
      state: string;
      abortController?: { abort: ReturnType<typeof vi.fn> };
      reloadPromise?: { resolve: () => void; reject: (error?: unknown) => void } | null;
    } = {
      actor,
      state: 'loaded',
      abortController: controller,
    };
    const reloadTile = vi.fn();
    const automaticReload = vi.fn();
    const triggerRepaint = vi.fn();
    const setTiles = vi.fn();
    const manager = {
      clearTiles,
      getIds: vi.fn(() => ['tile-1']),
      getTileByID: vi.fn(() => tile),
      _reloadTile: reloadTile,
      reload: automaticReload,
    };
    const load = vi.fn();
    const source = {
      map: {
        style: { tileManagers: { 'reload-test': manager } },
        triggerRepaint,
      },
      tiles: ['stalx://reload-test/{z}/{x}/{y}?v=1'],
      _options: { type: 'vector' as const, tiles: ['stalx://reload-test/{z}/{x}/{y}?v=1'] },
      setTiles,
      load,
    };

    const replacement = reloadVtSource(source as unknown as VectorTileSource, 'reload-test', 2);

    let replacementSettled = false;
    void replacement.then(() => { replacementSettled = true; });
    await Promise.resolve();
    expect(replacementSettled).toBe(false);

    // The URL is never rewritten and no tile is cleared: geometry stays visible.
    expect(source.tiles).toEqual(['stalx://reload-test/{z}/{x}/{y}?v=1']);
    expect(load).not.toHaveBeenCalled();
    expect(clearTiles).not.toHaveBeenCalled();
    expect(automaticReload).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(reloadTile).not.toHaveBeenCalled();
    expect(tile.actor).toBe(actor);
    expect(triggerRepaint).toHaveBeenCalledOnce();
    expect(setTiles).not.toHaveBeenCalled();

    tile.reloadPromise?.resolve();
    await expect(replacement).resolves.toBe(true);
  });

  it('swallows the drain reload when the tile is removed before MapLibre re-issues it', async () => {
    // MapLibre's own queued reload, awaited by TileManager._loadTile. Rejecting
    // it there fires a source ErrorEvent (the console burst). It must be resolved
    // cleanly, never rejected, once the tile is gone.
    const queued = { resolve: vi.fn(), reject: vi.fn() };
    const tile: {
      state: string;
      abortController?: { abort: ReturnType<typeof vi.fn> };
      reloadPromise?: { resolve: () => void; reject: (error?: unknown) => void } | null;
    } = { state: 'loaded', abortController: { abort: vi.fn() }, reloadPromise: queued };
    let removed = false;
    const reloadTile = vi.fn();
    const setTiles = vi.fn();
    const manager = {
      getIds: vi.fn(() => ['tile-1']),
      // Resident when we queue behind the active load; gone (zoom churn / cache
      // reset dropped it, and with it the worker's loaded[uid]) by drain time.
      getTileByID: vi.fn(() => (removed ? undefined : tile)),
      _reloadTile: reloadTile,
    };
    const source = {
      map: {
        style: { tileManagers: { 'drain-removed-test': manager } },
        triggerRepaint: vi.fn(),
      },
      tiles: ['stalx://drain-removed-test/{z}/{x}/{y}?v=1'],
      _options: { type: 'vector' as const, tiles: ['stalx://drain-removed-test/{z}/{x}/{y}?v=1'] },
      setTiles,
    };

    const rejections: unknown[] = [];
    const onRejection = (e: PromiseRejectionEvent): void => {
      e.preventDefault();
      rejections.push(e.reason);
    };
    globalThis.addEventListener?.('unhandledrejection', onRejection);
    try {
      const replacement = reloadVtSource(source as unknown as VectorTileSource, 'drain-removed-test', 2);
      await vi.waitFor(() => expect(tile.reloadPromise).not.toBe(queued));
      expect(reloadTile).not.toHaveBeenCalled();

      // The tile is evicted, then MapLibre's un-guarded drain re-issues the reload
      // and the worker rejects it because loaded[uid] is gone.
      removed = true;
      tile.reloadPromise!.reject(
        new Error('Should not be trying to reload a tile that was never loaded or has been removed'),
      );

      await expect(replacement).resolves.toBe(true);
      // No reload issued for the dead tile, no stale-URL fallback, and the wrapped
      // MapLibre promise settled cleanly (resolve, never reject -> no ErrorEvent).
      expect(reloadTile).not.toHaveBeenCalled();
      expect(setTiles).not.toHaveBeenCalled();
      expect(queued.reject).not.toHaveBeenCalled();
      expect(queued.resolve).toHaveBeenCalledOnce();
      // Give any stray rejection a tick to surface.
      await Promise.resolve();
      expect(rejections).toEqual([]);
    } finally {
      globalThis.removeEventListener?.('unhandledrejection', onRejection);
    }
  });

  it('still falls back to a URL reload when a resident tile genuinely fails to reload', async () => {
    // The dead-tile swallow must not mask a real failure: a tile still resident
    // at drain time propagates its rejection to the stale-URL fallback.
    const queued = { resolve: vi.fn(), reject: vi.fn() };
    const tile: {
      state: string;
      abortController?: { abort: ReturnType<typeof vi.fn> };
      reloadPromise?: { resolve: () => void; reject: (error?: unknown) => void } | null;
    } = { state: 'loaded', abortController: { abort: vi.fn() }, reloadPromise: queued };
    const setTiles = vi.fn();
    const manager = {
      getIds: vi.fn(() => ['tile-1']),
      getTileByID: vi.fn(() => tile), // stays resident
      _reloadTile: vi.fn(),
    };
    const source = {
      map: {
        style: { tileManagers: { 'drain-live-fail-test': manager } },
        triggerRepaint: vi.fn(),
      },
      tiles: ['stalx://drain-live-fail-test/{z}/{x}/{y}?v=1'],
      _options: { type: 'vector' as const, tiles: ['stalx://drain-live-fail-test/{z}/{x}/{y}?v=1'] },
      setTiles,
    };

    const replacement = reloadVtSource(source as unknown as VectorTileSource, 'drain-live-fail-test', 2);
    await vi.waitFor(() => expect(tile.reloadPromise).not.toBe(queued));

    tile.reloadPromise!.reject(new Error('worker parse failed'));

    await expect(replacement).resolves.toBe(true);
    // Live-tile failure: propagated to MapLibre and to the stale-URL fallback.
    expect(queued.reject).toHaveBeenCalledOnce();
    expect(setTiles).toHaveBeenCalledWith(['stalx://drain-live-fail-test/{z}/{x}/{y}?v=2']);
  });

  it('swallows a still-resident tile\'s "should not be trying to reload" rejection (worker uid gone)', async () => {
    // The residency check is main-thread-only: a tile can still sit in the pyramid
    // while its WORKER-side uid was already dropped, so the drain's re-issued
    // reload throws "Should not be trying to reload...". That message must gate the
    // swallow - settle the wrapped promise clean (no ErrorEvent), NO stale-URL
    // setTiles fallback - and the trailing reconcile still converges the tile.
    vi.useFakeTimers();
    const key = 'drain-uid-gone-test';
    setVtLayerData(key, vtPointsFromFeatures(pointsAt([[1, 1]])));
    const queued = { resolve: vi.fn(), reject: vi.fn() };
    const tile: {
      state: string;
      abortController?: { abort: ReturnType<typeof vi.fn> };
      reloadPromise?: { resolve: () => void; reject: (error?: unknown) => void } | null;
      tileID: { canonical: { z: number; x: number; y: number } };
    } = {
      state: 'loaded',
      abortController: { abort: vi.fn() },
      reloadPromise: queued,
      tileID: { canonical: { z: 2, x: 0, y: 0 } },
    };
    const reloadTile = vi.fn(() => Promise.resolve());
    const setTiles = vi.fn();
    const manager = {
      _outOfViewCache: { reset: vi.fn(), filter: vi.fn() },
      getIds: vi.fn(() => ['t']),
      getTileByID: vi.fn(() => tile), // stays resident on the main thread throughout
      _reloadTile: reloadTile,
    };
    const source = {
      map: { style: { tileManagers: { [key]: manager } }, triggerRepaint: vi.fn() },
      tiles: [`stalx://${key}/{z}/{x}/{y}?v=1`],
      setTiles,
    };
    try {
      const replacement = reloadVtSource(source as unknown as VectorTileSource, key, 2);
      // Publish runs synchronously up to its await, wrapping the tile's reloadPromise.
      await vi.advanceTimersByTimeAsync(0);
      expect(tile.reloadPromise).not.toBe(queued);
      expect(reloadTile).not.toHaveBeenCalled();

      // The worker rejects the drain's re-issued reload for the dropped uid; the
      // tile then finishes loading fresh data (uid re-reserved) before the reconcile.
      tile.reloadPromise!.reject(
        new Error('Should not be trying to reload a tile that was never loaded or has been removed'),
      );
      delete tile.abortController;
      await vi.advanceTimersByTimeAsync(0);

      await expect(replacement).resolves.toBe(true);
      // Swallowed: the wrapped MapLibre promise resolved (never rejected -> no
      // ErrorEvent), and no wasteful stale-URL refetch fired.
      expect(queued.resolve).toHaveBeenCalledOnce();
      expect(queued.reject).not.toHaveBeenCalled();
      expect(setTiles).not.toHaveBeenCalled();

      // The trailing reconcile still converges the (now loaded) resident tile.
      await vi.advanceTimersByTimeAsync(300);
      expect(reloadTile).toHaveBeenCalledWith('t', 'expired');
    } finally {
      vi.useRealTimers();
      clearVtLayerData(key);
    }
  });

  it('restarts an initial source load before any geometry is resident', () => {
    const setTiles = vi.fn();
    const source = {
      tiles: ['stalx://initial-test/{z}/{x}/{y}?v=0'],
      _options: { type: 'vector' as const, tiles: ['stalx://initial-test/{z}/{x}/{y}?v=0'] },
      setTiles,
    };

    reloadVtSource(source as unknown as VectorTileSource, 'initial-test', 1);

    expect(setTiles).toHaveBeenCalledWith(['stalx://initial-test/{z}/{x}/{y}?v=1']);
  });

  it('preserves MapLibre queued reloads for tiles that are still loading', async () => {
    const abort = vi.fn();
    const reloadPromise = { resolve: vi.fn(), reject: vi.fn() };
    const tile = { state: 'loading', abortController: { abort }, reloadPromise };
    const reloadTile = vi.fn();
    const manager = {
      clearTiles: vi.fn(),
      getIds: vi.fn(() => ['tile-1']),
      getTileByID: vi.fn(() => tile),
      _reloadTile: reloadTile,
    };
    const source = {
      map: {
        style: { tileManagers: { 'loading-test': manager } },
        triggerRepaint: vi.fn(),
      },
      tiles: ['stalx://loading-test/{z}/{x}/{y}?v=1'],
      _options: { type: 'vector' as const, tiles: ['stalx://loading-test/{z}/{x}/{y}?v=1'] },
      setTiles: vi.fn(),
    };

    const replacement = reloadVtSource(
      source as unknown as VectorTileSource,
      'loading-test',
      2,
    );
    await vi.waitFor(() => expect(tile.reloadPromise).not.toBe(reloadPromise));

    expect(abort).not.toHaveBeenCalled();
    expect(reloadTile).not.toHaveBeenCalled();
    tile.reloadPromise.resolve();
    await expect(replacement).resolves.toBe(true);
    expect(reloadPromise.resolve).toHaveBeenCalledOnce();
  });

  it('skips a bare reload on a loading tile with no queued reload (no un-wrapped reloadPromise, no rejection escape)', async () => {
    // A tile mid-load with NO reloadPromise: a bare `_reloadTile` would make
    // MapLibre mint its own reloadPromise the app never wraps, whose later drain
    // re-issues an "RT" for a dropped uid and surfaces a source ErrorEvent.
    // reloadTileGuarded must skip it instead - the tile is already loading the
    // current payload through the protocol, and the trailing reconcile re-cuts it.
    const tile = { state: 'loading' };
    const reloadTile = vi.fn(() => Promise.resolve());
    const setTiles = vi.fn();
    const manager = {
      getIds: vi.fn(() => ['tile-1']),
      getTileByID: vi.fn(() => tile),
      _reloadTile: reloadTile,
    };
    const source = {
      map: {
        style: { tileManagers: { 'loading-no-promise-test': manager } },
        triggerRepaint: vi.fn(),
      },
      tiles: ['stalx://loading-no-promise-test/{z}/{x}/{y}?v=1'],
      _options: { type: 'vector' as const, tiles: ['stalx://loading-no-promise-test/{z}/{x}/{y}?v=1'] },
      setTiles,
    };

    const rejections: unknown[] = [];
    const onRejection = (e: PromiseRejectionEvent): void => {
      e.preventDefault();
      rejections.push(e.reason);
    };
    globalThis.addEventListener?.('unhandledrejection', onRejection);
    try {
      const replacement = reloadVtSource(source as unknown as VectorTileSource, 'loading-no-promise-test', 2);
      await expect(replacement).resolves.toBe(true);
      // No bare `_reloadTile` was issued, and no un-wrapped MapLibre reloadPromise
      // was minted on the tile (which would leak an un-awaited drain).
      expect(reloadTile).not.toHaveBeenCalled();
      expect(tile).not.toHaveProperty('reloadPromise');
      // No stale-URL fallback and no rejection escaped to the unhandled queue.
      expect(setTiles).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(rejections).toEqual([]);
    } finally {
      globalThis.removeEventListener?.('unhandledrejection', onRejection);
    }
  });

  it('updates the current viewport when source metadata lands before tile IDs exist', async () => {
    // A resident tile update() surfaces: it re-cuts in place. (A tile still mid-
    // load with no queued reload is skipped by reloadTileGuarded - covered by the
    // "skips a bare reload on a loading tile with no queued reload" test below.)
    const tile = { state: 'loaded' };
    let ids: string[] = [];
    let finishTileReload: (() => void) | undefined;
    const manager = {
      clearTiles: vi.fn(),
      transform: {},
      terrain: undefined,
      getIds: vi.fn(() => ids),
      getTileByID: vi.fn(() => tile),
      _reloadTile: vi.fn(() => new Promise<void>((resolve) => {
        finishTileReload = resolve;
      })),
      update: vi.fn(() => { ids = ['tile-1']; }),
    };
    const source = {
      map: {
        style: { tileManagers: { 'viewport-test': manager } },
        triggerRepaint: vi.fn(),
      },
      tiles: ['stalx://viewport-test/{z}/{x}/{y}?v=1'],
      _options: { type: 'vector' as const, tiles: ['stalx://viewport-test/{z}/{x}/{y}?v=1'] },
      setTiles: vi.fn(),
    };

    const replacement = reloadVtSource(
      source as unknown as VectorTileSource,
      'viewport-test',
      2,
    );
    await vi.waitFor(() => expect(manager.update).toHaveBeenCalled());
    expect(manager._reloadTile).toHaveBeenCalledWith('tile-1', 'expired');
    finishTileReload?.();
    await expect(replacement).resolves.toBe(true);

    expect(manager.update).toHaveBeenCalledWith(manager.transform, manager.terrain);
    expect(manager.getTileByID).toHaveBeenCalledWith('tile-1');
  });

  it('reloads only resident tiles intersecting dirty mercator bounds', async () => {
    const near = {
      state: 'loaded',
      tileID: { canonical: { z: 2, x: 0, y: 0 } },
    };
    const far = {
      state: 'loaded',
      tileID: { canonical: { z: 2, x: 3, y: 3 } },
    };
    const manager = {
      getIds: vi.fn(() => ['near', 'far']),
      getTileByID: vi.fn((id: string) => id === 'near' ? near : far),
      _reloadTile: vi.fn(() => Promise.resolve()),
    };
    const source = {
      map: {
        style: { tileManagers: { 'dirty-test': manager } },
        triggerRepaint: vi.fn(),
      },
      tiles: ['stalx://dirty-test/{z}/{x}/{y}?v=1'],
      setTiles: vi.fn(),
    };

    await expect(reloadVtSource(
      source as unknown as VectorTileSource,
      'dirty-test',
      2,
      [0, 0, 0.1, 0.1],
    )).resolves.toBe(true);

    expect(manager._reloadTile).toHaveBeenCalledOnce();
    expect(manager._reloadTile).toHaveBeenCalledWith('near', 'expired');
  });

  it('evicts non-resident cached tiles overlapping the dirty bounds', async () => {
    const resident = { state: 'loaded', tileID: { canonical: { z: 2, x: 0, y: 0 } } };
    // Two tiles evicted to the out-of-view cache at a different zoom: one over
    // the dirty region, one far away. Only the overlapping one must be dropped.
    const cachedNear = { tileID: { canonical: { z: 4, x: 0, y: 0 } } };
    const cachedFar = { tileID: { canonical: { z: 4, x: 15, y: 15 } } };
    let cached = [cachedNear, cachedFar];
    const outOfViewCache = {
      reset: vi.fn(() => { cached = []; }),
      filter: vi.fn((fn: (tile: typeof cachedNear) => boolean) => { cached = cached.filter(fn); }),
    };
    const manager = {
      _outOfViewCache: outOfViewCache,
      getIds: vi.fn(() => ['resident']),
      getTileByID: vi.fn(() => resident),
      _reloadTile: vi.fn(() => Promise.resolve()),
    };
    const source = {
      map: {
        style: { tileManagers: { 'cache-dirty-test': manager } },
        triggerRepaint: vi.fn(),
      },
      tiles: ['stalx://cache-dirty-test/{z}/{x}/{y}?v=1'],
      setTiles: vi.fn(),
    };

    await expect(reloadVtSource(
      source as unknown as VectorTileSource,
      'cache-dirty-test',
      2,
      [0, 0, 0.1, 0.1],
    )).resolves.toBe(true);

    expect(outOfViewCache.reset).not.toHaveBeenCalled();
    expect(outOfViewCache.filter).toHaveBeenCalledOnce();
    expect(cached).toEqual([cachedFar]);
  });

  it('resets the whole out-of-view cache on a full (unbounded) reload', async () => {
    const resident = { state: 'loaded', tileID: { canonical: { z: 2, x: 0, y: 0 } } };
    const outOfViewCache = { reset: vi.fn(), filter: vi.fn() };
    const manager = {
      _outOfViewCache: outOfViewCache,
      getIds: vi.fn(() => ['resident']),
      getTileByID: vi.fn(() => resident),
      _reloadTile: vi.fn(() => Promise.resolve()),
    };
    const source = {
      map: {
        style: { tileManagers: { 'cache-full-test': manager } },
        triggerRepaint: vi.fn(),
      },
      tiles: ['stalx://cache-full-test/{z}/{x}/{y}?v=1'],
      setTiles: vi.fn(),
    };

    await expect(reloadVtSource(
      source as unknown as VectorTileSource,
      'cache-full-test',
      2,
    )).resolves.toBe(true);

    expect(outOfViewCache.reset).toHaveBeenCalledOnce();
    expect(outOfViewCache.filter).not.toHaveBeenCalled();
  });

  it('serializes an undo publication behind an in-flight delete tile reload', async () => {
    const aborts: ReturnType<typeof vi.fn>[] = [];
    const reloadResolvers: Array<() => void> = [];
    const tile: {
      aborted: boolean;
      abortController?: { abort: ReturnType<typeof vi.fn> };
      state: string;
    } = { aborted: false, state: 'loaded' };
    const reloadTile = vi.fn(() => {
      tile.state = 'expired';
      const abort = vi.fn();
      aborts.push(abort);
      tile.abortController = { abort };
      // Model MapLibre: on completion it clears the abortController and the tile
      // returns to 'loaded'. A newer reload observing the finished tile must
      // re-issue, not queue behind a controller that no longer has a live load.
      return new Promise<void>((resolve) => {
        reloadResolvers.push(() => {
          tile.state = 'loaded';
          delete tile.abortController;
          resolve();
        });
      });
    });
    const manager = {
      clearTiles: vi.fn(),
      getIds: vi.fn(() => ['tile-1']),
      getTileByID: vi.fn(() => tile),
      _reloadTile: reloadTile,
    };
    const source = {
      map: {
        style: { tileManagers: { 'undo-overlap-test': manager } },
        triggerRepaint: vi.fn(),
      },
      tiles: ['stalx://undo-overlap-test/{z}/{x}/{y}?v=1'],
      _options: { type: 'vector' as const, tiles: ['stalx://undo-overlap-test/{z}/{x}/{y}?v=1'] },
      setTiles: vi.fn(),
    };

    const deletion = reloadVtSource(
      source as unknown as VectorTileSource,
      'undo-overlap-test',
      2,
    );
    await vi.waitFor(() => expect(reloadTile).toHaveBeenCalledTimes(1));

    const undo = reloadVtSource(
      source as unknown as VectorTileSource,
      'undo-overlap-test',
      3,
    );
    await expect(deletion).resolves.toBe(false);
    expect(aborts[0]).not.toHaveBeenCalled();
    expect(tile.aborted).toBe(false);
    expect(tile.state).toBe('expired');
    expect(reloadTile).toHaveBeenCalledTimes(1);

    reloadResolvers[0]!();
    await vi.waitFor(() => expect(reloadTile).toHaveBeenCalledTimes(2));
    expect(tile.aborted).toBe(false);

    reloadResolvers[1]!();
    await expect(undo).resolves.toBe(true);
    expect(source.setTiles).not.toHaveBeenCalled();
  });

  it('skips the deferred reload when the tile is evicted before it runs', async () => {
    const reloadResolvers: Array<() => void> = [];
    const reloadTile = vi.fn(() => new Promise<void>((resolve) => { reloadResolvers.push(resolve); }));
    let evicted = false;
    const liveTile = { state: 'loaded' };
    const manager = {
      clearTiles: vi.fn(),
      getIds: vi.fn(() => ['tile-1']),
      // Resident at snapshot time, gone by the time the deferred reload runs.
      getTileByID: vi.fn(() => (evicted ? undefined : liveTile)),
      _reloadTile: reloadTile,
    };
    const source = {
      map: {
        style: { tileManagers: { 'evict-deferred-test': manager } },
        triggerRepaint: vi.fn(),
      },
      tiles: ['stalx://evict-deferred-test/{z}/{x}/{y}?v=1'],
      _options: { type: 'vector' as const, tiles: ['stalx://evict-deferred-test/{z}/{x}/{y}?v=1'] },
      setTiles: vi.fn(),
    };

    const first = reloadVtSource(source as unknown as VectorTileSource, 'evict-deferred-test', 2);
    await vi.waitFor(() => expect(reloadTile).toHaveBeenCalledTimes(1));

    // A newer publication serializes behind the reload still in flight.
    const second = reloadVtSource(source as unknown as VectorTileSource, 'evict-deferred-test', 3);
    await expect(first).resolves.toBe(false);

    // Zoom churn drops the tile between the id snapshot and the deferred reload.
    evicted = true;
    reloadResolvers[0]!();

    await expect(second).resolves.toBe(true);
    // The dropped id is never reloaded again (would throw in MapLibre's worker).
    expect(reloadTile).toHaveBeenCalledTimes(1);
    expect(source.setTiles).not.toHaveBeenCalled();
  });

  it('queues, not reloads, when the tile is mid-load by the time the deferred reload runs', async () => {
    const reloadResolvers: Array<() => void> = [];
    const reloadTile = vi.fn(() => new Promise<void>((resolve) => { reloadResolvers.push(resolve); }));
    const tile: {
      state: string;
      abortController?: { abort: ReturnType<typeof vi.fn> };
      reloadPromise?: { resolve: () => void; reject: (error?: unknown) => void } | null;
    } = { state: 'loaded' };
    const manager = {
      clearTiles: vi.fn(),
      getIds: vi.fn(() => ['tile-1']),
      getTileByID: vi.fn(() => tile),
      _reloadTile: reloadTile,
    };
    const source = {
      map: {
        style: { tileManagers: { 'loading-deferred-test': manager } },
        triggerRepaint: vi.fn(),
      },
      tiles: ['stalx://loading-deferred-test/{z}/{x}/{y}?v=1'],
      _options: { type: 'vector' as const, tiles: ['stalx://loading-deferred-test/{z}/{x}/{y}?v=1'] },
      setTiles: vi.fn(),
    };

    const first = reloadVtSource(source as unknown as VectorTileSource, 'loading-deferred-test', 2);
    await vi.waitFor(() => expect(reloadTile).toHaveBeenCalledTimes(1));

    const second = reloadVtSource(source as unknown as VectorTileSource, 'loading-deferred-test', 3);
    await expect(first).resolves.toBe(false);

    // A fresh replacement tile is mid-load (uid not yet on the worker) when the
    // deferred reload fires. Reloading it would throw; it must queue instead.
    tile.state = 'loading';
    const queued = { resolve: vi.fn(), reject: vi.fn() };
    tile.reloadPromise = queued;
    reloadResolvers[0]!();

    await vi.waitFor(() => expect(tile.reloadPromise).not.toBe(queued));
    expect(reloadTile).toHaveBeenCalledTimes(1);

    tile.reloadPromise!.resolve();
    await expect(second).resolves.toBe(true);
    expect(queued.resolve).toHaveBeenCalledOnce();
    expect(source.setTiles).not.toHaveBeenCalled();
  });

  it('re-issues a superseded publication\'s tiles under the new generation (supersession union)', async () => {
    // Publication N reloads tile A (in R1) and holds it in flight; publication
    // N+1 arrives with a disjoint rectangle R2 covering only tile B. Without the
    // union, N+1 would touch only B and A would be left in whatever half-applied
    // state N reached -> phantom / duplicate. The union folds N's unsettled R1
    // into N+1, so A is re-issued under N+1's generation too.
    const reloadCalls: Array<{ id: string; resolve: () => void }> = [];
    const reloadTile = vi.fn((id: string) => new Promise<void>((resolve) => {
      reloadCalls.push({ id, resolve });
    }));
    const tileA = { state: 'loaded', tileID: { canonical: { z: 2, x: 0, y: 0 } } };
    const tileB = { state: 'loaded', tileID: { canonical: { z: 2, x: 3, y: 3 } } };
    const manager = {
      getIds: vi.fn(() => ['A', 'B']),
      getTileByID: vi.fn((id: string) => (id === 'A' ? tileA : tileB)),
      _reloadTile: reloadTile,
    };
    const source = {
      map: {
        style: { tileManagers: { 'supersede-union-test': manager } },
        triggerRepaint: vi.fn(),
      },
      tiles: ['stalx://supersede-union-test/{z}/{x}/{y}?v=1'],
      setTiles: vi.fn(),
    };

    // R1 covers only tile A (mercator [0,0.25]^2); B is skipped.
    const r1: [number, number, number, number] = [0.01, 0.01, 0.05, 0.05];
    const n = reloadVtSource(source as unknown as VectorTileSource, 'supersede-union-test', 2, r1);
    await vi.waitFor(() => expect(reloadTile).toHaveBeenCalledTimes(1));
    expect(reloadTile).toHaveBeenNthCalledWith(1, 'A', 'expired');

    // R2 covers only tile B ([0.75,1]^2), disjoint from R1. N is superseded.
    const r2: [number, number, number, number] = [0.9, 0.9, 0.95, 0.95];
    const nPlus1 = reloadVtSource(source as unknown as VectorTileSource, 'supersede-union-test', 3, r2);
    await expect(n).resolves.toBe(false);

    // N+1's union(R1,R2) reloads B now and queues A behind N's in-flight reload.
    await vi.waitFor(() => expect(reloadCalls.some((c) => c.id === 'B')).toBe(true));

    // Finish N's A reload; the deferred A reload then fires under N+1's generation.
    reloadCalls.find((c) => c.id === 'A')!.resolve();
    await vi.waitFor(() =>
      expect(reloadTile.mock.calls.filter((c) => c[0] === 'A')).toHaveLength(2),
    );

    // Drain the remaining reloads so N+1 settles.
    reloadCalls.forEach((c) => c.resolve());
    await expect(nPlus1).resolves.toBe(true);

    const reloadedIds = reloadTile.mock.calls.map((c) => c[0]);
    expect(reloadedIds.filter((id) => id === 'A')).toHaveLength(2); // R1 tile re-issued under N+1
    expect(reloadedIds.filter((id) => id === 'B')).toHaveLength(1); // R2 tile
    expect(source.setTiles).not.toHaveBeenCalled();
  });

  it('falls back to a URL reload when a controlled tile replacement rejects', async () => {
    const clearTiles = vi.fn();
    const setTiles = vi.fn();
    const manager = {
      clearTiles,
      getIds: vi.fn(() => ['tile-1']),
      getTileByID: vi.fn(() => ({ state: 'loaded' })),
      _reloadTile: vi.fn(() => Promise.reject(new Error('tile reload failed'))),
    };
    const source = {
      map: {
        style: { tileManagers: { 'failure-test': manager } },
        triggerRepaint: vi.fn(),
      },
      tiles: ['stalx://failure-test/{z}/{x}/{y}?v=1'],
      _options: { type: 'vector' as const, tiles: ['stalx://failure-test/{z}/{x}/{y}?v=1'] },
      setTiles,
    };

    const replacement = reloadVtSource(source as unknown as VectorTileSource, 'failure-test', 2);
    await vi.waitFor(() => {
      expect(setTiles).toHaveBeenCalledWith(['stalx://failure-test/{z}/{x}/{y}?v=2']);
    });

    await expect(replacement).resolves.toBe(true);
  });

  it('serves the current payload to stale version URLs', async () => {
    const first = setVtLayerData('versioned-test', vtPointsFromFeatures([]));
    const second = setVtLayerData('versioned-test', data);

    const stale = await handler({ url: tileUrl('versioned-test', first.version) });
    expect(stale.data.byteLength).toBeGreaterThan(0);
    const current = await handler({ url: tileUrl('versioned-test', second.version) });
    expect(current.data.byteLength).toBeGreaterThan(0);
    clearVtLayerData('versioned-test');
    const cleared = await handler({ url: tileUrl('versioned-test', second.version) });
    expect(cleared.data.byteLength).toBe(0);
  });

  // Emptied-tile correctness (MapLibre 5.16, traced from the installed sources):
  // `_reloadTile(id,'expired')` sets tile.state='expired', which makes
  // VectorTileSource.loadTile send an "LT" loadTile — a real re-fetch through the
  // stalx protocol, not a cached re-parse. A tile the re-cut empties returns a
  // zero-byte ArrayBuffer; the worker parses it as a valid empty vector tile
  // (zero layers -> zero buckets), and Tile.loadVectorData() calls
  // unloadVectorData() first (state 'expired' counts as hasData), destroying the
  // prior bucket before installing the empty one. So an in-place empty reload
  // provably clears the old geometry — a plain reload is correct; these tests
  // lock that no reload path SKIPS a tile that will cut empty.
  it('reloads a tile the bounded rectangle empties, clearing its now-empty bucket', async () => {
    const emptied = { state: 'loaded', tileID: { canonical: { z: 2, x: 0, y: 0 } } };
    const manager = {
      getIds: vi.fn(() => ['emptied']),
      getTileByID: vi.fn(() => emptied),
      _reloadTile: vi.fn(() => Promise.resolve()),
    };
    const source = {
      map: {
        style: { tileManagers: { 'empty-rect-test': manager } },
        triggerRepaint: vi.fn(),
      },
      tiles: ['stalx://empty-rect-test/{z}/{x}/{y}?v=1'],
      setTiles: vi.fn(),
    };

    // A move whose old + new positions both sit inside tile (2,0,0)'s region:
    // the tile is covered by the rectangle, so it re-cuts (possibly empty) in
    // place rather than being skipped.
    await expect(reloadVtSource(
      source as unknown as VectorTileSource,
      'empty-rect-test',
      2,
      [0.01, 0.01, 0.05, 0.05],
    )).resolves.toBe(true);

    expect(manager._reloadTile).toHaveBeenCalledWith('emptied', 'expired');
  });

  it('routes a group removal through a full reload so the emptied tile is re-cut, not skipped', async () => {
    const key = 'structural-empty-test';
    setVtLayerData(key, vtPointsFromFeatures([
      { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { featureId: 1 } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [40, 40] }, properties: { featureId: 2 } },
    ]));
    // Remove the second group: structural -> undefined -> full reload.
    const publication = setVtLayerData(key, vtPointsFromFeatures([
      { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { featureId: 1 } },
    ]));
    expect(publication.dirtyBounds).toBeUndefined();

    // Tile the removed group used to occupy. A bounded rectangle around the lone
    // survivor need not cover it, but the full reload reloads every resident tile.
    const emptied = { state: 'loaded', tileID: { canonical: { z: 2, x: 3, y: 3 } } };
    const outOfViewCache = { reset: vi.fn(), filter: vi.fn() };
    const manager = {
      _outOfViewCache: outOfViewCache,
      getIds: vi.fn(() => ['emptied']),
      getTileByID: vi.fn(() => emptied),
      _reloadTile: vi.fn(() => Promise.resolve()),
    };
    const source = {
      map: {
        style: { tileManagers: { [key]: manager } },
        triggerRepaint: vi.fn(),
      },
      tiles: [`stalx://${key}/{z}/{x}/{y}?v=1`],
      setTiles: vi.fn(),
    };

    await expect(reloadVtSource(
      source as unknown as VectorTileSource,
      key,
      publication.version,
      publication.dirtyBounds,
    )).resolves.toBe(true);

    expect(manager._reloadTile).toHaveBeenCalledWith('emptied', 'expired');
    // Full reload resets the whole out-of-view cache (no bounded filter).
    expect(outOfViewCache.reset).toHaveBeenCalledOnce();
    expect(outOfViewCache.filter).not.toHaveBeenCalled();

    clearVtLayerData(key);
  });

  describe('setVtLayerData dirty bounds', () => {
    beforeEach(() => {
      clearVtLayerData('diff-test');
    });

    it('reports full bounds for the first publication and null for an unchanged republish', () => {
      const first = setVtLayerData('diff-test', vtPointsFromFeatures(pointsAt([[1, 1], [2, 2]])));
      expect(first.dirtyBounds).not.toBeNull();

      // Re-publish an equal payload (fresh typed arrays, same coords/props/ids).
      const second = setVtLayerData('diff-test', vtPointsFromFeatures(pointsAt([[1, 1], [2, 2]])));
      expect(second.dirtyBounds).toBeNull();
    });

    it('bounds a single-group move to that group and skips first-publication empties', () => {
      // Empty first publication -> null bounds (nothing to render, nothing to reload).
      const empty = setVtLayerData('diff-test', vtPointsFromFeatures([]));
      expect(empty.dirtyBounds).toBeNull();

      setVtLayerData('diff-test', vtPointsFromFeatures(pointsAt([[0, 0], [10, 10]])));
      const moved = setVtLayerData('diff-test', vtPointsFromFeatures(pointsAt([[0, 0], [10, 20]])));
      expect(moved.dirtyBounds).not.toBeNull();
      expect(moved.dirtyBounds).not.toBeUndefined();
      // Only the second group moved (lng 10, lat 10 -> 20). The unchanged group
      // sits at mercator (0.5, 0.5); the scoped rect must exclude it in both
      // axes, proving the diff is bounded to the group that actually changed.
      const [minX, , , maxY] = moved.dirtyBounds!;
      expect(minX).toBeGreaterThan(0.5);
      expect(maxY).toBeLessThan(0.5);
    });

    // A structural edit (group added / removed / reordered, or the undo of one)
    // can empty resident tiles wholesale, so it must route to a full in-place
    // reload (dirtyBounds === undefined) rather than a bounded rectangle that a
    // superseding publication or a skipped tile could leave stale.
    it('reports undefined (full reload) when a group is removed', () => {
      setVtLayerData('diff-test', vtPointsFromFeatures(pointsAt([[1, 1], [2, 2]])));
      const removed = setVtLayerData('diff-test', vtPointsFromFeatures(pointsAt([[1, 1]])));
      expect(removed.dirtyBounds).toBeUndefined();
    });

    it('reports undefined (full reload) when a group is added', () => {
      setVtLayerData('diff-test', vtPointsFromFeatures(pointsAt([[1, 1]])));
      const added = setVtLayerData('diff-test', vtPointsFromFeatures(pointsAt([[1, 1], [2, 2]])));
      expect(added.dirtyBounds).toBeUndefined();
    });

    it('reports undefined (full reload) when groups are reordered', () => {
      const forward = pointsAt([[1, 1], [2, 2]]); // ids 1,2
      const reversed: GeoJSON.Feature[] = [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 2] }, properties: { featureId: 2 } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { featureId: 1 } },
      ];
      setVtLayerData('diff-test', vtPointsFromFeatures(forward));
      const shuffled = setVtLayerData('diff-test', vtPointsFromFeatures(reversed));
      expect(shuffled.dirtyBounds).toBeUndefined();
    });

    it('keeps a rectangle for a same-structure move and null for an unchanged republish', () => {
      setVtLayerData('diff-test', vtPointsFromFeatures(pointsAt([[0, 0], [10, 10]])));
      const moved = setVtLayerData('diff-test', vtPointsFromFeatures(pointsAt([[0, 0], [10, 20]])));
      expect(moved.dirtyBounds).not.toBeNull();
      expect(moved.dirtyBounds).not.toBeUndefined();
      const unchanged = setVtLayerData('diff-test', vtPointsFromFeatures(pointsAt([[0, 0], [10, 20]])));
      expect(unchanged.dirtyBounds).toBeNull();
    });
  });

  // The reload decision must key off whether the RESIDENT tiles have converged to
  // the payload, not the payload-vs-previous-snapshot diff alone. A superseded /
  // abandoned reload leaves `settled < target`; a later null diff ("no-op net
  // publish") or a bounded rectangle would then leave those stranded tiles stale
  // (#customRender label-stale fix — labels from a prior geometry state lingering
  // while the custom-rendered geometry is already correct).
  describe('decideReload convergence', () => {
    const rect: [number, number, number, number] = [0.1, 0.1, 0.2, 0.2];

    it('honours a bounded rectangle for a content change when tiles were caught up', () => {
      const conv = { target: 1, settled: 1 };
      const d = decideReload(conv, rect);
      expect(conv.target).toBe(2); // content change advances the target
      expect(d).toEqual({ reload: true, bounds: rect, targetAtStart: 2, reconcile: false });
    });

    it('upgrades a bounded rectangle to a full reload when there is a backlog', () => {
      // One content change already published (target 1) but never settled (0):
      // the resident tiles lag, so a rectangle cannot reconcile the tiles a prior
      // superseded reload left stale outside it — force a full reload.
      const conv = { target: 1, settled: 0 };
      const d = decideReload(conv, rect);
      expect(conv.target).toBe(2);
      expect(d).toEqual({ reload: true, bounds: undefined, targetAtStart: 2, reconcile: false });
    });

    it('keeps a structural change (undefined diff) a full reload', () => {
      const conv = { target: 1, settled: 1 };
      const d = decideReload(conv, undefined);
      expect(conv.target).toBe(2);
      expect(d.reload).toBe(true);
      expect(d.bounds).toBeUndefined();
      expect(d.reconcile).toBe(false);
    });

    it('skips a null publish when the resident tiles are already settled (flash-free no-op)', () => {
      const conv = { target: 3, settled: 3 };
      const d = decideReload(conv, null);
      expect(conv.target).toBe(3); // a null diff never advances the target
      expect(d.reload).toBe(false);
      expect(d.reconcile).toBe(false);
    });

    it('forces a full reconcile on a null publish when the resident tiles lag', () => {
      // The "no-op net publish": the payload equals the previous snapshot, but a
      // superseded reload left the resident tiles behind. Reconcile them fully.
      const conv = { target: 3, settled: 1 };
      const d = decideReload(conv, null);
      expect(conv.target).toBe(3);
      expect(d).toEqual({ reload: true, bounds: undefined, targetAtStart: 3, reconcile: true });
    });
  });
});

// End-to-end guard through reloadVtSource: once a reload settles the source, a
// null-diff republish is a true no-op (no tile reload); but if the resident tiles
// were left behind, a null-diff republish reconciles them with a full reload.
describe('reloadVtSource resident-tile convergence', () => {
  function makeSource(key: string, reloadTile = vi.fn(() => Promise.resolve())) {
    const resident = { state: 'loaded', tileID: { canonical: { z: 2, x: 0, y: 0 } } };
    const manager = {
      _outOfViewCache: { reset: vi.fn(), filter: vi.fn() },
      getIds: vi.fn(() => ['resident']),
      getTileByID: vi.fn(() => resident),
      _reloadTile: reloadTile,
    };
    const source = {
      map: { style: { tileManagers: { [key]: manager } }, triggerRepaint: vi.fn() },
      tiles: [`stalx://${key}/{z}/{x}/{y}?v=1`],
      setTiles: vi.fn(),
    };
    return { source, manager, reloadTile };
  }

  it('arms a debounced trailing reconcile that re-cuts resident tiles, then self-terminates', async () => {
    // The in-flight reload machinery does not guarantee per-tile convergence under
    // concurrency, so a trailing quiescent reconcile re-cuts every resident tile;
    // it must fire once (debounced) and NOT re-arm on a quiescent source.
    vi.useFakeTimers();
    const key = 'reconcile-arm-test';
    setVtLayerData(key, vtPointsFromFeatures(pointsAt([[1, 1]])));
    const reloadTile = vi.fn(() => Promise.resolve());
    const resident = { state: 'loaded', tileID: { canonical: { z: 2, x: 0, y: 0 } } };
    const manager = {
      _outOfViewCache: { reset: vi.fn(), filter: vi.fn() },
      getIds: vi.fn(() => ['t']),
      getTileByID: vi.fn(() => resident),
      _reloadTile: reloadTile,
    };
    const source = {
      map: { style: { tileManagers: { [key]: manager } }, triggerRepaint: vi.fn() },
      tiles: [`stalx://${key}/{z}/{x}/{y}?v=1`],
      setTiles: vi.fn(),
    };
    try {
      const p = reloadVtSource(source as unknown as VectorTileSource, key, 2, undefined);
      await vi.advanceTimersByTimeAsync(0);
      await p;
      const afterRegular = reloadTile.mock.calls.length;
      expect(afterRegular).toBe(1);

      // The debounced trailing reconcile fires and re-cuts the resident tile.
      await vi.advanceTimersByTimeAsync(300);
      const afterReconcile = reloadTile.mock.calls.length;
      expect(afterReconcile).toBeGreaterThan(afterRegular);

      // Quiescent: the reconcile pass does not arm another (no runaway reloads).
      await vi.advanceTimersByTimeAsync(600);
      expect(reloadTile.mock.calls.length).toBe(afterReconcile);
    } finally {
      vi.useRealTimers();
      clearVtLayerData(key);
    }
  });

  it('no-ops repeated null publishes once the resident tiles have settled (flash-free path)', async () => {
    // Guards the flash-free / autosave no-op: after a content change settles the
    // source, the recurring null-diff republishes (e.g. a warnings refresh) must
    // NOT thrash the tiles with reconciling reloads.
    const key = 'converged-null-test';
    const { source, reloadTile } = makeSource(key);
    await expect(
      reloadVtSource(source as unknown as VectorTileSource, key, 2, [0.01, 0.01, 0.05, 0.05]),
    ).resolves.toBe(true);
    expect(reloadTile).toHaveBeenCalledTimes(1);
    await expect(reloadVtSource(source as unknown as VectorTileSource, key, 3, null)).resolves.toBe(true);
    await expect(reloadVtSource(source as unknown as VectorTileSource, key, 4, null)).resolves.toBe(true);
    expect(reloadTile).toHaveBeenCalledTimes(1);
    clearVtLayerData(key);
  });

  // #customRender station-label converge: the trailing reconcile is a DIRECT
  // `_reloadTile` sweep of every LOADED resident tile, bypassing the in-flight
  // generation / deferral machinery. Under a delete's churn that machinery leaves
  // resident tiles `loaded` but holding stale geometry (payload fresh) because
  // every content reload got superseded before re-cutting; a reload routed
  // through the generation path defers behind a stuck in-flight entry and never
  // re-cuts. The quiescent direct sweep always converges them (verified live).
  it('reconcile directly re-cuts loaded resident tiles it never converged in-flight', async () => {
    vi.useFakeTimers();
    const key = 'reconcile-direct-test';
    setVtLayerData(key, vtPointsFromFeatures(pointsAt([[1, 1]])));
    // A loaded tile that a superseded in-flight reload left stale: `_reloadTile`
    // has NOT been called on it, yet it is `loaded` (no abortController).
    const reloadTile = vi.fn(() => Promise.resolve());
    const tile = { state: 'loaded', tileID: { canonical: { z: 2, x: 0, y: 0 } } };
    const manager = {
      _outOfViewCache: { reset: vi.fn(), filter: vi.fn() },
      getIds: vi.fn(() => ['t']),
      getTileByID: vi.fn(() => tile),
      _reloadTile: reloadTile,
    };
    const source = {
      map: { style: { tileManagers: { [key]: manager } }, triggerRepaint: vi.fn() },
      tiles: [`stalx://${key}/{z}/{x}/{y}?v=1`],
      setTiles: vi.fn(),
    };
    try {
      // A null-diff publish whose watermark is behind (settled < target) arms the
      // reconcile without any in-flight reload converging the tile.
      void reloadVtSource(source as unknown as VectorTileSource, key, 2, null);
      await vi.advanceTimersByTimeAsync(300);
      // The direct sweep re-cut the loaded tile even though no in-flight reload did.
      expect(reloadTile).toHaveBeenCalledWith('t', 'expired');
      const calls = reloadTile.mock.calls.length;
      // Quiescent: no runaway (a loaded, converged source stops reloading).
      await vi.advanceTimersByTimeAsync(600);
      expect(reloadTile.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
      clearVtLayerData(key);
    }
  });

  it('reconcile skips a mid-load tile, re-arms, then re-cuts it once it is loaded', async () => {
    vi.useFakeTimers();
    const key = 'reconcile-rearm-test';
    setVtLayerData(key, vtPointsFromFeatures(pointsAt([[1, 1]])));
    const reloadTile = vi.fn(() => Promise.resolve());
    // Mid-load at the first reconcile (reloading a loading tile throws in MapLibre,
    // and its in-flight load can land intermediate-payload geometry), then loaded.
    const tile: { state: string; tileID: { canonical: { z: number; x: number; y: number } } } = {
      state: 'loading',
      tileID: { canonical: { z: 2, x: 0, y: 0 } },
    };
    const manager = {
      _outOfViewCache: { reset: vi.fn(), filter: vi.fn() },
      getIds: vi.fn(() => ['t']),
      getTileByID: vi.fn(() => tile),
      _reloadTile: reloadTile,
    };
    const source = {
      map: { style: { tileManagers: { [key]: manager } }, triggerRepaint: vi.fn() },
      tiles: [`stalx://${key}/{z}/{x}/{y}?v=1`],
      setTiles: vi.fn(),
    };
    try {
      void reloadVtSource(source as unknown as VectorTileSource, key, 2, null);
      // First reconcile: tile still loading -> skipped, NOT reloaded, re-armed.
      await vi.advanceTimersByTimeAsync(300);
      expect(reloadTile).not.toHaveBeenCalled();
      // The tile finishes loading (with stale intermediate geometry).
      tile.state = 'loaded';
      // The re-armed reconcile fires and re-cuts it to the current payload.
      await vi.advanceTimersByTimeAsync(300);
      expect(reloadTile).toHaveBeenCalledWith('t', 'expired');
      const calls = reloadTile.mock.calls.length;
      await vi.advanceTimersByTimeAsync(600);
      expect(reloadTile.mock.calls.length).toBe(calls); // converged -> self-terminates
    } finally {
      vi.useRealTimers();
      clearVtLayerData(key);
    }
  });

  it('bounds reconcile retries so a perpetually-loading tile cannot spin the timer forever', async () => {
    vi.useFakeTimers();
    const key = 'reconcile-bounded-test';
    setVtLayerData(key, vtPointsFromFeatures(pointsAt([[1, 1]])));
    const reloadTile = vi.fn(() => Promise.resolve());
    // A tile that never leaves 'loading' — the reconcile can never re-cut it.
    const tile = { state: 'loading', tileID: { canonical: { z: 2, x: 0, y: 0 } } };
    const manager = {
      _outOfViewCache: { reset: vi.fn(), filter: vi.fn() },
      getIds: vi.fn(() => ['t']),
      getTileByID: vi.fn(() => tile),
      _reloadTile: reloadTile,
    };
    const source = {
      map: { style: { tileManagers: { [key]: manager } }, triggerRepaint: vi.fn() },
      tiles: [`stalx://${key}/{z}/{x}/{y}?v=1`],
      setTiles: vi.fn(),
    };
    try {
      void reloadVtSource(source as unknown as VectorTileSource, key, 2, null);
      // Run well past the retry cap (25 * 200ms = 5s); the timer must stop re-arming.
      await vi.advanceTimersByTimeAsync(200 * 40);
      const timersAfterCap = vi.getTimerCount();
      await vi.advanceTimersByTimeAsync(200 * 10);
      // No reload ever fired (tile never loaded) and the reconcile stopped re-arming.
      expect(reloadTile).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(timersAfterCap);
      expect(timersAfterCap).toBe(0);
    } finally {
      vi.useRealTimers();
      clearVtLayerData(key);
    }
  });
});
