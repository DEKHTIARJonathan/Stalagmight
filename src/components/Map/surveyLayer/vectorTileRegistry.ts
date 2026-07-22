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

/**
 * Per-source convergence watermarks (#customRender label-stale fix).
 *
 * `target` counts payload CONTENT changes published for the source (every
 * `setVtLayerData` whose diff is non-null). `settled` is the highest `target`
 * whose reload has cleanly brought the source's RESIDENT tiles into sync with
 * the registry payload. When `settled < target` the resident tiles lag the
 * payload — a reload was superseded/abandoned mid-flight, or skipped.
 *
 * Why this is needed: the `dirtyBounds` diff compares the new payload against
 * the PREVIOUS REGISTRY payload, not against what the resident tiles actually
 * hold. Under rapid churn (fast undo/redo, drag storms) a reload can be
 * superseded before it re-cuts every tile, leaving stale label features
 * resident while the registry payload is already fresh. A later `dirtyBounds`
 * === null publish (the "no-op net publish") then skips the reload entirely, and
 * a bounded rectangle only re-cuts its own region — so the stranded tiles are
 * never reconciled and keep painting labels from a prior geometry state. The
 * watermarks let the reload decision key off the resident-tile lag instead of a
 * snapshot equality that can no-op while the tiles are stale.
 */
interface ReloadConvergence {
  target: number;
  settled: number;
}
const convergence = new Map<string, ReloadConvergence>();
function getConvergence(key: string): ReloadConvergence {
  let conv = convergence.get(key);
  if (!conv) {
    conv = { target: 0, settled: 0 };
    convergence.set(key, conv);
  }
  return conv;
}

/** How a publication must reconcile the resident tiles, given the payload diff
 *  and the source's convergence watermarks. */
export interface ReloadDecision {
  /** Whether any reload must run at all. `false` is the flash-free / autosave
   *  no-op: the payload is unchanged AND the resident tiles are known current. */
  reload: boolean;
  /** Effective reload region (`undefined` = full). Meaningful only when
   *  `reload`. A backlog upgrades a bounded rectangle to a full reconcile. */
  bounds: VtDirtyBounds | undefined;
  /** The `target` this reload brings the resident tiles to; stamped into
   *  `settled` when it completes cleanly. */
  targetAtStart: number;
  /** True only for a null-payload reconcile (resident tiles lag but the content
   *  did not change). The caller must additionally skip when a reload is already
   *  in flight for the source — that in-flight reload will converge the tiles,
   *  so forcing another would just thrash. */
  reconcile: boolean;
}

/**
 * Decide how a publication reconciles the resident tiles. Advances
 * `conv.target` when the payload content changed (a non-null diff), then:
 *
 *   - content unchanged (`dirtyBounds === null`): skip when the tiles are
 *     already settled (`settled >= target`); otherwise force a full reconcile
 *     (`reconcile`) so stranded tiles are re-cut;
 *   - content changed: honour the bounded rectangle only when the tiles were
 *     already caught up to the previous payload (`settled >= target - 1`);
 *     a backlog upgrades to a full reload, since a rectangle cannot reconcile
 *     tiles a prior superseded reload left stale outside it.
 *
 * Pure apart from the intended `conv.target` advance.
 */
export function decideReload(
  conv: ReloadConvergence,
  dirtyBounds: VtDirtyBounds | null | undefined,
): ReloadDecision {
  const contentChanged = dirtyBounds !== null;
  if (contentChanged) conv.target += 1;
  const behind = conv.settled < conv.target;
  if (!contentChanged) {
    if (!behind) return { reload: false, bounds: undefined, targetAtStart: conv.target, reconcile: false };
    return { reload: true, bounds: undefined, targetAtStart: conv.target, reconcile: true };
  }
  const bounds = conv.settled < conv.target - 1 ? undefined : (dirtyBounds ?? undefined);
  return { reload: true, bounds, targetAtStart: conv.target, reconcile: false };
}

interface ReloadState {
  generation: number;
  inFlightReloads: Map<string, Promise<void>>;
  settle?: (replaced: boolean) => void;
  /** Reload region of the publication currently in flight (unsettled), where a
   *  rectangle is bounded and `undefined` is a full reload. A superseding
   *  publication unions this into its own region so tiles the superseded pass
   *  had not yet refreshed are still re-issued under the new generation. Null
   *  when no publication is in flight (a clean completion deletes the state,
   *  which naturally clears it). */
  pending: { bounds: VtDirtyBounds | undefined } | null;
}
const reloadStates = new WeakMap<VectorTileSource, ReloadState>();

/**
 * Debounced trailing full reconcile per source (#customRender label-stale fix).
 *
 * A single quiescent full reload always converges the resident tiles to the
 * registry payload (verified live); the in-flight reload machinery does not,
 * because `getIds()` is snapshotted and superseded / worker-token-superseded /
 * dead-tile reloads can no-op — a delete + adjustment + warnings burst flushes
 * several reloads at once and none of them re-cuts every tile. So after every
 * regular reload completes, arm a short debounce that, once activity stops,
 * re-cuts every resident tile. The debounce collapses a churn (fast undo/redo,
 * drag storm, delete + re-solve) into ONE trailing pass and self-terminates: the
 * reconcile pass runs with `isReconcile` and never arms another, so a quiescent
 * source stops reloading. In-place, so it never blanks the map.
 */
const RECONCILE_DELAY_MS = 200;
const reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * Bounded per-source reconcile-retry counter. A reconcile that runs while some
 * resident tiles are still mid-load skips them (reloading a loading tile throws
 * in MapLibre) and re-arms itself so a later quiescent pass re-cuts them; the cap
 * stops a perpetually-loading tile from spinning the timer forever. Reset on each
 * genuine content publish (a new edit is fresh work, not a stuck retry).
 */
const RECONCILE_MAX_RETRIES = 25;
const reconcileRetries = new Map<string, number>();

/**
 * The quiescent trailing reconcile: a DIRECT, unconditional re-cut of every
 * resident tile, deliberately bypassing the in-flight generation / deferral
 * machinery of {@link reloadVtSource}.
 *
 * Why not just call `reloadVtSource(..., isReconcile=true)`? Under a delete's
 * churn (fast undo/redo → edit + coordinate re-solve + warnings) the generation
 * machinery leaves the source with a lingering `reloadStates` entry whose
 * `inFlightReloads` holds a reload that never re-cut its tile (its MapLibre
 * reloadPromise drain never fired, or a deferred reload was skipped by a
 * generation bump). Every subsequent reload — including a reconcile routed
 * through `reloadVtSource` — then queues BEHIND that stuck entry and skips its
 * own `_reloadTile`, so the resident tiles never converge to the (already fresh)
 * registry payload. That is the permanent stale-label strand: verified live, a
 * hard `_reloadTile` sweep or `setTiles` fixes it while the in-flight path does
 * not. The debounce guarantees this runs only once the source has quiesced, so a
 * plain `_reloadTile('expired')` on each loaded tile is safe and re-cuts it
 * against the current payload in place (no blank). Tiles genuinely mid-load are
 * skipped — MapLibre rejects reloading a loading/aborting tile, and they will
 * finish loading against the current payload through the protocol anyway.
 */
function reconcileResidentTiles(source: VectorTileSource, key: string): void {
  const manager = source.map.style?.tileManagers?.[key];
  if (!manager) return;
  // Drop any lingering per-source reload state so a stuck in-flight reload cannot
  // make MapLibre queue this sweep's reloads behind it; a mid-load tile is still
  // guarded below. Its orphaned promise settles harmlessly on its own next check.
  const stale = reloadStates.get(source);
  if (stale) {
    stale.settle?.(false);
    reloadStates.delete(source);
  }
  // Invalidate the out-of-view cache in full so a later zoom cannot reintroduce a
  // pre-edit tile after we have re-cut the resident pyramid.
  evictCachedTiles(manager as { _outOfViewCache?: TileCacheLike }, undefined);
  let ids = manager.getIds();
  if (ids.length === 0 && manager.transform) {
    manager.update(manager.transform, manager.terrain);
    ids = manager.getIds();
  }
  let skipped = 0;
  for (const id of ids) {
    const tile = manager.getTileByID(id) as ReloadTile | undefined;
    if (!tile) continue;
    // A tile mid-load: leave it — reloading a loading/aborting tile throws in
    // MapLibre. Its in-flight load can still land geometry cut from an
    // intermediate churn payload, so count it and retry below once it settles.
    if (tile.abortController || tile.state === 'loading') {
      skipped++;
      continue;
    }
    manager._reloadTile(id, 'expired');
  }
  source.map.triggerRepaint();
  const conv = getConvergence(key);
  if (skipped === 0) {
    // The sweep re-cut every resident tile to the current payload: the source
    // has converged to the latest published target.
    conv.settled = conv.target;
    reconcileRetries.delete(key);
    return;
  }
  // Some tiles were still mid-load; their in-flight reload may land stale
  // geometry cut from an intermediate churn payload (verified live: after a
  // delete's fast undo/redo the tiles finish loading `loaded` but stale, and a
  // reconcile that fired while they loaded skipped them and never returned). Do
  // NOT mark the source settled, and re-arm a debounced pass to re-cut them once
  // they settle — bounded so a stuck-loading tile cannot spin the timer forever.
  const retries = (reconcileRetries.get(key) ?? 0) + 1;
  if (retries > RECONCILE_MAX_RETRIES) {
    reconcileRetries.delete(key);
    return;
  }
  reconcileRetries.set(key, retries);
  scheduleReconcile(source, key);
}

function scheduleReconcile(source: VectorTileSource, key: string): void {
  const existing = reconcileTimers.get(key);
  if (existing) clearTimeout(existing);
  reconcileTimers.set(
    key,
    setTimeout(() => {
      reconcileTimers.delete(key);
      const version = registry.get(key)?.version;
      if (version === undefined) return; // source dropped (project close / teardown)
      reconcileResidentTiles(source, key);
    }, RECONCILE_DELAY_MS),
  );
}

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
  convergence.delete(key);
  reconcileRetries.delete(key);
  const timer = reconcileTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    reconcileTimers.delete(key);
  }
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

/** Union two reload regions. `undefined` (a full reload) swallows everything;
 *  otherwise return a fresh rectangle covering both (inputs are never mutated —
 *  either may be an array still referenced by an in-flight publication). */
function unionDirtyRegions(
  a: VtDirtyBounds | undefined,
  b: VtDirtyBounds | undefined,
): VtDirtyBounds | undefined {
  if (a === undefined || b === undefined) return undefined;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
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
 * MapLibre's worker throws this exact message when a reload targets a tile whose
 * worker-side `loaded[uid]` was already dropped - zoom churn, a structural full
 * reload, or an out-of-view-cache reset removed the tile between the reload being
 * queued and MapLibre's drain re-issuing the "RT" worker message. Under the
 * in-place reload design this is benign: the tile's next load reserves fresh
 * worker data and the trailing reconcile re-cuts it. The main-thread residency
 * check cannot observe it (the tile can still sit in the pyramid while its worker
 * uid is gone), so match the message and settle such a rejection as a no-op
 * rather than firing a source ErrorEvent or the wasteful stale-URL `setTiles`
 * refetch.
 */
const RELOAD_REMOVED_MESSAGE = /Should not be trying to reload/;
export function isReloadRemovedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return RELOAD_REMOVED_MESSAGE.test(message);
}

/** The subset of a MapLibre map `error` event our boundary filter inspects. As
 *  a source tile error bubbles to `map.on('error')` it is merged with the tile
 *  manager's evented-parent data, so the delivered event carries `sourceId`
 *  alongside the underlying `error`. Both are optional/unknown here so a
 *  malformed or non-source error event is classified without throwing. */
export interface MapErrorEventLike {
  error?: unknown;
  sourceId?: unknown;
}

/**
 * Whether a MapLibre map `error` event is a benign worker-uid-gone tile-reload
 * race for one of this survey's `stalx://` sources - the residual noise MapLibre
 * fires from its own `_loadTile` catch for reloadPromises it mints internally
 * (e.g. `reloadTilesForDependencies` marks a tile `'reloading'` and its drain
 * re-issues a load on a tile first seen mid-load), upstream of
 * `reloadTileGuarded`, so the in-registry swallows can never reach it. It is
 * benign to correctness (the trailing reconcile re-cuts the errored tile) but is
 * console/telemetry noise.
 *
 * Suppress ONLY when BOTH hold: the error message is the reload-removed
 * signature ({@link isReloadRemovedError}) AND the event's source id belongs to
 * this survey (prefix match). Anything else - a different message, or the same
 * message from a non-survey source - returns `false` and must pass through
 * untouched. Defensive against a missing/non-string `sourceId` or a missing
 * `error`.
 */
export function shouldSuppressMapError(
  evt: MapErrorEventLike | null | undefined,
  surveySourcePrefix: string,
): boolean {
  const sourceId = evt?.sourceId;
  if (typeof sourceId !== 'string' || !sourceId.startsWith(surveySourcePrefix)) return false;
  return isReloadRemovedError(evt?.error);
}

/**
 * Queue this publication behind the tile's active worker request instead of
 * reloading now. VectorTileSource drains `reloadPromise` after its active load
 * and starts one more load itself, so chaining onto it (rather than aborting or
 * polling a private controller, both of which can strand a renderable tile)
 * lets the newer payload ride behind the load in flight.
 *
 * That drain (`_afterTileLoadWorkerResponse` -> `this.loadTile(tile)`) re-issues
 * the reload with NO residency re-check: if zoom churn / a structural full
 * reload / an out-of-view-cache reset removed the tile between queuing and the
 * drain, its worker `loaded[uid]` was already dropped, so the re-issued load
 * throws "Should not be trying to reload a tile that was never loaded or has
 * been removed". When we wrap a MapLibre-owned `reloadPromise` (one awaited by
 * `TileManager._loadTile`), propagating that rejection makes `_loadTile` fire a
 * source `ErrorEvent` (the console burst) and our own settle rejects into the
 * stale-URL `setTiles` fallback (a full, wasteful refetch).
 *
 * So re-read residency under our generation when the drain settles: a tile that
 * is gone (or a superseded generation) resolves cleanly — the wrapped promise is
 * released without an error and no fallback fires. A still-resident tile's
 * genuine reload failure still propagates so the fallback path is preserved.
 */
function queueAfterActiveLoad(
  tile: ReloadTile,
  manager: VtTileManager,
  source: VectorTileSource,
  state: ReloadState,
  generation: number,
  id: string,
): Promise<void> {
  const queued = tile.reloadPromise;
  const tileStillResident = (): boolean => {
    const latest = reloadStates.get(source);
    if (latest !== state || latest.generation !== generation) return false;
    return manager.getTileByID(id) !== undefined;
  };
  return new Promise<void>((resolve, reject) => {
    tile.reloadPromise = {
      resolve: () => {
        queued?.resolve();
        resolve();
      },
      reject: (error) => {
        // Propagate ONLY a genuine failure of a tile that is still resident AND
        // whose worker uid survives. A "should not be trying to reload" rejection
        // means the worker uid was already dropped - a residual race the
        // main-thread residency check cannot see - so treat it, like a dead or
        // superseded tile, as a benign no-op: settle the wrapped MapLibre promise
        // cleanly (no ErrorEvent) and skip the stale-URL setTiles fallback. The
        // trailing reconcile converges the tile.
        if (tileStillResident() && !isReloadRemovedError(error)) {
          queued?.reject(error);
          reject(error);
          return;
        }
        queued?.resolve();
        resolve();
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
 * evicted tile is skipped, as is a still-loading tile with no queued reload (a
 * bare reload would leave an un-wrapped MapLibre reloadPromise whose drain can
 * fire a spurious source ErrorEvent); an active load (abortController) or a
 * still-loading tile with a queued reload is routed through
 * `queueAfterActiveLoad` instead.
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
  if (tile.abortController) return queueAfterActiveLoad(tile, manager, source, state, generation, id);
  if (tile.state === 'loading') {
    // A mid-load tile WITH a queued reload: chain behind it so the newer payload
    // rides the load in flight. WITHOUT one, a bare `_reloadTile` makes MapLibre
    // mint its own reloadPromise we never wrap; its later drain can re-issue an
    // "RT" worker message for a uid the worker already dropped, which throws and
    // surfaces as a source ErrorEvent (the console burst). Skip it instead - the
    // tile is already loading the current payload through the protocol, and the
    // trailing reconcile sweep re-cuts it once it settles (its skipped-tiles
    // retry loop re-arms for loading tiles).
    return tile.reloadPromise
      ? queueAfterActiveLoad(tile, manager, source, state, generation, id)
      : Promise.resolve();
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
  isReconcile = false,
): Promise<boolean> {
  if (!source) return Promise.resolve(true);
  // Arm the debounced trailing reconcile for ANY publish activity — including a
  // watermark null-skip and a superseded reload that never reaches a clean
  // completion. Neither the in-flight machinery nor the watermark completion is a
  // per-tile convergence guarantee under concurrency, so once publishes stop the
  // trailing pass re-cuts every resident tile. Debounced: rapid publishes reset
  // it, so it only fires when the source has quiesced. A genuine publish is fresh
  // work, so clear any stuck reconcile-retry backlog before arming.
  if (!isReconcile) {
    reconcileRetries.delete(key);
    scheduleReconcile(source, key);
  }
  // Decide against the resident-tile convergence watermarks, not a bare payload
  // diff: a null diff still forces a reconcile when a prior reload left tiles
  // stale, and a bounded rectangle upgrades to a full reload when there is a
  // backlog (#customRender label-stale fix).
  const conv = getConvergence(key);
  const decision = decideReload(conv, dirtyBounds);
  if (!decision.reload) return Promise.resolve(true);
  // A null-payload reconcile: if a reload is already in flight it will bring the
  // tiles current, so do not thrash by starting another full reconcile behind it.
  if (decision.reconcile && reloadStates.get(source)) return Promise.resolve(true);
  const targetAtStart = decision.targetAtStart;
  dirtyBounds = decision.bounds;
  const tiles = [vtTileUrl(key, version)];

  // The first publication can race the source's initial empty v0 request. A
  // normal setTiles() is safe here because no survey geometry is resident yet.
  if (source.tiles[0] === vtTileUrl(key, 0)) {
    source.setTiles(tiles);
    conv.settled = Math.max(conv.settled, targetAtStart);
    return Promise.resolve(true);
  }

  const manager = source.map.style.tileManagers[key];
  if (!manager) {
    // No resident tiles yet; whenever they load the protocol serves the current
    // payload, so mark the source settled to the published target.
    conv.settled = Math.max(conv.settled, targetAtStart);
    return Promise.resolve(true);
  }

  let state = reloadStates.get(source);
  if (!state) {
    state = {
      generation: 0,
      inFlightReloads: new Map(),
      pending: null,
    };
    reloadStates.set(source, state);
  }

  // Fold any still-unsettled prior publication's region into this one. If that
  // publication is superseded before it refreshes every tile it owned, the tiles
  // it missed still fall inside this union and get re-issued under the new
  // generation — closing the forward-edit-then-quick-undo window. A clean
  // completion deletes the state, so `pending` is only ever set while an overlap
  // is genuinely in flight. `dirtyBounds === null` already returned above, so the
  // incoming region here is a rectangle or `undefined` (full).
  const incoming: VtDirtyBounds | undefined = dirtyBounds ?? undefined;
  const effectiveBounds = state.pending
    ? unionDirtyRegions(incoming, state.pending.bounds)
    : incoming;

  state.settle?.(false);
  const generation = ++state.generation;
  state.pending = { bounds: effectiveBounds };
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
        // The tile manager was replaced (style reload): the fresh tiles serve the
        // current payload through the protocol, so treat the target as settled.
        conv.settled = Math.max(conv.settled, targetAtStart);
        settle(true);
        return;
      }

      // Invalidate cached other-zoom tiles up front so a later zoom cannot reuse
      // pre-edit geometry. Independent of the resident reload the handoff awaits.
      evictCachedTiles(manager as { _outOfViewCache?: TileCacheLike }, effectiveBounds);

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
        if (effectiveBounds && canonical && !canonicalIntersectsDirtyBounds(canonical, effectiveBounds)) {
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
      // This generation re-cut every resident tile it owns to the current payload
      // (a full reload covers all tiles; a bounded one is only issued when the
      // rest were already settled; a rejection falls back to setTiles below, which
      // refetches every tile). The resident tiles have converged to targetAtStart.
      conv.settled = Math.max(conv.settled, targetAtStart);
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
