import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VectorTileSource } from 'maplibre-gl';

const maplibreMocks = vi.hoisted(() => ({ addProtocol: vi.fn() }));

vi.mock('maplibre-gl', () => ({ addProtocol: maplibreMocks.addProtocol }));

import {
  clearVtLayerData,
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

  it('updates the current viewport when source metadata lands before tile IDs exist', async () => {
    const tile = { state: 'loading' };
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
      // Only the second group moved (lng 10, lat 10 -> 20). The unchanged group
      // sits at mercator (0.5, 0.5); the scoped rect must exclude it in both
      // axes, proving the diff is bounded to the group that actually changed.
      const [minX, , , maxY] = moved.dirtyBounds!;
      expect(minX).toBeGreaterThan(0.5);
      expect(maxY).toBeLessThan(0.5);
    });
  });
});
