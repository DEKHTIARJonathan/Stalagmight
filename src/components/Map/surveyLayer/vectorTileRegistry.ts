/**
 * Main-thread registry + `addProtocol` handler for the on-demand survey
 * vector tiles (#mem). See `vectorTileData.ts` for the data model, the tile
 * cutter, the MVT encoder and the rationale.
 *
 * SurveyLayer stores each bulk layer's `VtLayerData` here under a stable key.
 * The versioned URL bootstraps the source, then resident tiles are reloaded in
 * place while the protocol serves the registry's single current payload. This
 * keeps existing geometry renderable until each replacement worker result lands,
 * so a mutation never blanks the map (the old `setTiles()` path cleared every
 * resident tile before refetching).
 */
import { addProtocol } from 'maplibre-gl';
import type { VectorTileSource } from 'maplibre-gl';
import {
  cutTile,
  diffVtLayerBounds,
  isStructuralChange,
  vtLayerBounds,
  type VtDirtyBounds,
  type VtLayerData,
} from './vectorTileData';

export const VT_PROTOCOL = 'stalx';

export interface VtLayerPublication {
  version: number;
  /** How the caller should reload after this publication:
   *  - a rectangle (mercator [minX,minY,maxX,maxY]) — a same-structure geometry
   *    edit; reload only the tiles it overlaps;
   *  - `null` — the payload is unchanged; skip the reload entirely (no refetch,
   *    no repaint — the autosave/no-op skip);
   *  - `undefined` — a structural edit (delete/merge/split/reorder/undo); reload
   *    every resident tile in place and reset the whole out-of-view cache, since
   *    a structural change can empty tiles wholesale. See `isStructuralChange`. */
  dirtyBounds: VtDirtyBounds | null | undefined;
}

const registry = new Map<string, { data: VtLayerData; version: number }>();

interface ReloadState {
  generation: number;
  inFlightReloads: Map<string, Promise<void>>;
  settle?: (replaced: boolean) => void;
}
const reloadStates = new WeakMap<VectorTileSource, ReloadState>();

let protocolRegistered = false;

/**
 * Store (replace) a layer's data and return the new version plus the dirty
 * bounds of the change vs. the previous payload. The version is used for the
 * initial source publication and stale-URL safety; live tiles read the
 * registry's current payload through their stable URL.
 */
export function setVtLayerData(key: string, data: VtLayerData): VtLayerPublication {
  const entry = registry.get(key);
  const version = (entry?.version ?? 0) + 1;
  const previous = entry?.data;
  registry.set(key, { data, version });
  // First publication: no previous payload to diff. The bootstrap reload turns a
  // rectangle here into a plain setTiles (nothing is resident yet), so a full
  // reload would be wasted; report the layer's extent (or null when empty).
  if (!previous) return { version, dirtyBounds: vtLayerBounds(data) };
  // Structural edit (group added/removed/reordered, or the undo of one): answer
  // with a full in-place reload (undefined) so no tile that lost its geometry is
  // left un-recut. Same-structure geometry edits keep the cheap rectangle diff;
  // an unchanged payload stays null so the autosave/no-op skip never regresses.
  if (isStructuralChange(previous, data)) return { version, dirtyBounds: undefined };
  return { version, dirtyBounds: diffVtLayerBounds(previous, data) };
}

/** Drop a layer's data (project close / layer teardown). Serving falls back
 *  to empty tiles until the next `setVtLayerData`. */
export function clearVtLayerData(key: string): void {
  registry.delete(key);
}

/** Tile URL template for a registry key at a version. */
export function vtTileUrl(key: string, version: number): string {
  return `${VT_PROTOCOL}://${key}/{z}/{x}/{y}?v=${version}`;
}

interface CanonicalTileCoord {
  z: number;
  x: number;
  y: number;
}

/** Whether a tile's buffered mercator extent overlaps the dirty region. Mirrors
 *  the cutter's 512/4096 clip buffer so edits near a tile edge still refresh the
 *  neighbour. */
function canonicalIntersectsDirtyBounds(
  canonical: CanonicalTileCoord,
  dirtyBounds: VtDirtyBounds,
): boolean {
  const span = 1 / 2 ** canonical.z;
  const buffer = (512 / 4096) * span;
  const tileMinX = canonical.x * span - buffer;
  const tileMinY = canonical.y * span - buffer;
  const tileMaxX = (canonical.x + 1) * span + buffer;
  const tileMaxY = (canonical.y + 1) * span + buffer;
  return !(
    tileMaxX < dirtyBounds[0] ||
    tileMinX > dirtyBounds[2] ||
    tileMaxY < dirtyBounds[1] ||
    tileMinY > dirtyBounds[3]
  );
}

interface TileCacheLike {
  reset(): unknown;
  filter(filterFn: (tile: { tileID?: { canonical?: CanonicalTileCoord } }) => boolean): void;
}

/**
 * Invalidate the non-resident (evicted) tiles a source keeps cached for other
 * zooms/viewports. The custom protocol only reloads tiles resident in the
 * current pyramid; the out-of-view cache is keyed by tile coordinate (not URL),
 * so a later zoom would re-add a pre-edit tile verbatim and show stale geometry
 * (#mem). Drop the cached tiles overlapping the dirty region so the zoom
 * re-requests fresh data; drop the whole cache on a full (unbounded) reload.
 */
function evictCachedTiles(
  manager: { _outOfViewCache?: TileCacheLike },
  dirtyBounds: VtDirtyBounds | undefined,
): void {
  const cache = manager._outOfViewCache;
  if (!cache) return;
  if (!dirtyBounds) {
    cache.reset();
    return;
  }
  cache.filter((tile) => {
    const canonical = tile.tileID?.canonical;
    if (!canonical) return true; // keep entries we cannot place
    return !canonicalIntersectsDirtyBounds(canonical, dirtyBounds);
  });
}

/** The maplibre-gl per-source tile manager. Its `TileManager` type is internal
 *  (not exported), so index it out of the public `VectorTileSource` type. */
type VtTileManager = VectorTileSource['map']['style']['tileManagers'][string];

/** The mutable subset of a resident tile the reload path reads/writes. */
type ReloadTile = {
  abortController?: AbortController;
  reloadPromise?: {
    resolve: () => void;
    reject: (error?: unknown) => void;
  } | null;
  aborted?: boolean;
  state?: string;
  tileID?: { canonical?: { z: number; x: number; y: number } };
} & object;

/**
 * Queue this publication behind the tile's active worker request instead of
 * reloading now. VectorTileSource drains `reloadPromise` after its active load
 * and starts one more load itself, so chaining onto it (rather than aborting or
 * polling a private controller, both of which can strand a renderable tile)
 * lets the newer payload ride behind the load in flight.
 */
function queueAfterActiveLoad(tile: ReloadTile): Promise<void> {
  const queued = tile.reloadPromise;
  return new Promise<void>((resolve, reject) => {
    tile.reloadPromise = {
      resolve: () => {
        queued?.resolve();
        resolve();
      },
      reject: (error) => {
        queued?.reject(error);
        reject(error);
      },
    };
  });
}

/**
 * Reload one resident tile in place, re-applying the loop's guards in the same
 * instant as `_reloadTile`. Both the synchronous loop and the deferred (post-
 * await) continuation call this, so zoom-driven tile churn between the id
 * snapshot and the actual reload cannot make us reload a dropped or mid-load
 * uid, which MapLibre's worker rejects with "Should not be trying to reload a
 * tile that was never loaded or has been removed". A stale generation or an
 * evicted tile is skipped; an active load (abortController) or a still-loading
 * tile with a queued reload is routed through `queueAfterActiveLoad` instead.
 */
function reloadTileGuarded(
  manager: VtTileManager,
  source: VectorTileSource,
  state: ReloadState,
  generation: number,
  id: string,
): Promise<void> {
  const latest = reloadStates.get(source);
  if (latest !== state || latest.generation !== generation) return Promise.resolve();
  const tile = manager.getTileByID(id) as ReloadTile | undefined;
  if (!tile) return Promise.resolve();
  if (tile.abortController) return queueAfterActiveLoad(tile);
  if (tile.state === 'loading') {
    return tile.reloadPromise
      ? queueAfterActiveLoad(tile)
      : Promise.resolve(manager._reloadTile(id, 'expired'));
  }
  return Promise.resolve(manager._reloadTile(id, 'expired'));
}

/**
 * Refresh a live source without changing its URL or clearing resident geometry.
 * The custom protocol always serves the registry's single current payload, so
 * an expired reload is sufficient and stale version URLs can never install an
 * empty tile. Existing tiles remain renderable until MapLibre atomically swaps
 * in the replacement worker result.
 *
 * `dirtyBounds` semantics: `null` -> nothing changed, skip; `undefined` -> full
 * (unbounded) reload of every resident tile + whole out-of-view cache reset; a
 * rectangle -> reload only the tiles it overlaps and evict just those cached.
 */
export function reloadVtSource(
  source: VectorTileSource | undefined,
  key: string,
  version: number,
  dirtyBounds?: VtDirtyBounds | null,
): Promise<boolean> {
  if (!source) return Promise.resolve(true);
  if (dirtyBounds === null) return Promise.resolve(true);
  const tiles = [vtTileUrl(key, version)];

  // The first publication can race the source's initial empty v0 request. A
  // normal setTiles() is safe here because no survey geometry is resident yet.
  if (source.tiles[0] === vtTileUrl(key, 0)) {
    source.setTiles(tiles);
    return Promise.resolve(true);
  }

  const manager = source.map.style.tileManagers[key];
  if (!manager) return Promise.resolve(true);

  let state = reloadStates.get(source);
  if (!state) {
    state = {
      generation: 0,
      inFlightReloads: new Map(),
    };
    reloadStates.set(source, state);
  }

  state.settle?.(false);
  const generation = ++state.generation;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (replaced: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(replaced);
    };
    state.settle = settle;

    const publish = async (): Promise<void> => {
      const current = reloadStates.get(source);
      if (current !== state || current.generation !== generation) {
        settle(false);
        return;
      }

      if (source.map.style?.tileManagers[key] !== manager) {
        reloadStates.delete(source);
        settle(true);
        return;
      }

      // Invalidate cached other-zoom tiles up front so a later zoom cannot reuse
      // pre-edit geometry. Independent of the resident reload the handoff awaits.
      evictCachedTiles(manager as { _outOfViewCache?: TileCacheLike }, dirtyBounds ?? undefined);

      // Keep each existing tile renderable while its worker result is replaced.
      let ids = manager.getIds();
      if (ids.length === 0 && manager.transform) {
        // Source metadata can finish before the next render updates the tile
        // pyramid. Populate the current viewport now instead of waiting for a
        // camera event to make the new geometry appear.
        manager.update(manager.transform, manager.terrain);
        ids = manager.getIds();
      }

      const reloads: Promise<void>[] = [];
      const trackReload = (id: string, replacement: Promise<void>): Promise<void> => {
        state.inFlightReloads.set(id, replacement);
        const cleanup = (): void => {
          if (state.inFlightReloads.get(id) === replacement) {
            state.inFlightReloads.delete(id);
          }
        };
        void replacement.then(cleanup, cleanup);
        return replacement;
      };
      for (const id of ids) {
        const tile = manager.getTileByID(id) as ReloadTile | undefined;
        if (!tile) continue;
        const canonical = tile.tileID?.canonical;
        if (dirtyBounds && canonical && !canonicalIntersectsDirtyBounds(canonical, dirtyBounds)) {
          continue;
        }
        const priorReload = state.inFlightReloads.get(id);
        if (priorReload) {
          // Serialize a newer publication behind the replacement already in
          // flight. Aborting MapLibre here can strand a renderable tile in its
          // reloading state after its source promise unwinds. The deferred
          // reload re-reads the tile through the same guard as the synchronous
          // path, since zoom churn can drop or replace its uid before this runs.
          const replacement = priorReload
            .catch(() => {})
            .then(() => reloadTileGuarded(manager, source, state, generation, id));
          reloads.push(trackReload(id, replacement));
          continue;
        }
        reloads.push(trackReload(id, reloadTileGuarded(manager, source, state, generation, id)));
      }
      source.map.triggerRepaint();
      const results = await Promise.allSettled(reloads);

      const latest = reloadStates.get(source);
      if (latest !== state || latest.generation !== generation) {
        settle(false);
        return;
      }
      reloadStates.delete(source);
      if (results.some((result) => result.status === 'rejected')) {
        // A failed replacement could leave an old tile resident. Clear through
        // the normal path so nothing stale stays on screen.
        source.setTiles(tiles);
      }
      settle(true);
    };
    void publish();
  });
}

/** Register the tile protocol once (idempotent). */
export function ensureVtProtocol(): void {
  if (protocolRegistered) return;
  protocolRegistered = true;
  addProtocol(VT_PROTOCOL, async (params) => {
    // URL shape: stalx://<key>/<z>/<x>/<y>?v=<n>
    const m = /^stalx:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) return { data: new ArrayBuffer(0) };
    const entry = registry.get(m[1]!);
    if (!entry) return { data: new ArrayBuffer(0) };
    // The version is a cache-buster, not a data snapshot. Always serve the one
    // current compact payload so a late request can never replace visible
    // geometry with an empty stale-version tile.
    const bytes = cutTile(entry.data, Number(m[2]), Number(m[3]), Number(m[4]));
    if (!bytes) return { data: new ArrayBuffer(0) };
    // The cutter returns an exact-size standalone Uint8Array; hand its buffer over.
    return { data: bytes.buffer as ArrayBuffer };
  });
}
