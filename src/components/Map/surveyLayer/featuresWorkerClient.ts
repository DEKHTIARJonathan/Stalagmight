/**
 * Main-thread client for the survey-features Worker.
 *
 * Lazily creates a Worker (torn down after each drained build to reclaim its
 * heap) and streams `build` requests through it group-by-group. Falls back to
 * a synchronous main-thread build if the Worker can't be constructed (e.g. in
 * test runners that don't support Vite's `?worker` syntax).
 *
 * The reply is streamed (#mem): the worker posts `begin` (palette), one `chunk`
 * per feature group, then `end`. The client forwards each to a `sink` so the
 * caller applies + drops each group as it lands rather than receiving one giant
 * `SurveyFeatureSets` clone (which made the main thread hold the full
 * ~178k-feature set live on top of what MapLibre already retains, inflating the
 * non-decommitting JSC heap).
 */
import {
  buildSurveyFeatures,
  SURVEY_FEATURE_GROUP_ORDER,
  type BuildSurveyFeaturesOptions,
  type DepthRange,
  type DisplayColorContext,
  type SurveyFeatureGroupKey,
} from './features';
import { buildShotStationVt, makeVtPalette } from './vtSurveyBuild';
import type { LoopClosure } from '../../../types/project';
import type { SurveyData } from '../../../types/survey-data';
import type { GpsOrigin, DecimalPrecision } from '../../../types/config';
import type { MapThemeColors } from '../../../utils/themeColors';
import { recordPerfTiming } from '../../../utils/memoryProbe';
import type { VtFeatureChunk, VtLayerData } from './vectorTileData';

interface BuildArgs {
  /** Struct-of-Arrays survey data. Posted to the worker via structured
   *  clone; the underlying typed arrays clone efficiently as a single
   *  large block per array (vs the legacy ~75k JS objects). */
  surveyData: SurveyData;
  loopClosures: LoopClosure[] | undefined;
  gpsOrigin: GpsOrigin | null;
  showDepthGradient: boolean;
  depthRange: DepthRange;
  themeColors: MapThemeColors;
  precision: DecimalPrecision | undefined;
  options: BuildSurveyFeaturesOptions;
}

/** Narrow granularity-swap args (#mem): rebuild ONLY shots + stations (the merge
 *  granularity does not affect labels / gradients / section-labels / loop-
 *  closures, so those stay resident). `seedPalette` seeds the interner with the
 *  caller's resident palette so shot/station colorIndex values match the last
 *  full build exactly. Keep in sync with featuresWorker.GranularitySwapArgs. */
export interface GranularitySwapArgs {
  surveyData: SurveyData;
  gpsOrigin: GpsOrigin | null;
  showDepthGradient: boolean;
  depthRange: DepthRange;
  themeColors: MapThemeColors;
  showIssueSeverity: boolean;
  issueSeverity: { shotSeverity: Uint8Array; stationSeverity: Uint8Array } | undefined;
  mergeFeatures: boolean;
  seedPalette: readonly string[];
}

/** A worker request: the full build or the narrow granularity swap. Both flow
 *  through the same single-flight scheduler and reply protocol. */
type WorkerRequest =
  | { kind: 'build'; args: BuildArgs }
  | { kind: 'buildGranularity'; args: GranularitySwapArgs };

/**
 * Streaming reply consumer. `begin` fires once (reset), then `chunk` once per
 * group as its build phase finishes — carrying a snapshot of the append-only
 * color palette at that point — then exactly one of `end` (success) or `error`.
 * The caller MUST drop its reference to each chunk's features after `chunk`
 * returns so the memory win holds.
 */
export interface FeatureStreamSink {
  begin(): void;
  chunk(group: SurveyFeatureGroupKey, payload: VtFeatureChunk, colorPalette: readonly string[]): void;
  end(): void;
  error(e: Error): void;
}

/** Worker singleton; created lazily on first use and torn down after each
 *  drained build (see `maybeReclaimWorker`). */
let workerInstance: Worker | null = null;
/** Set only when constructing the Worker THREW (Vite-without-worker, jsdom).
 *  Once construction fails we fall back to inline builds and never retry. A
 *  worker torn down for memory reclaim does NOT set this — it recreates lazily. */
let workerConstructionFailed = false;
/** In-flight streamed build requests keyed by id. Each entry is settled by an
 *  `end`/`error` message (or a worker-level error). At most ONE entry exists
 *  at a time (single-flight; see `queuedNext`). */
const pending = new Map<number, FeatureStreamSink>();
let nextRequestId = 0;

/**
 * Single-flight, last-wins build scheduling (#mem). The worker processes its
 * message queue strictly in order, so posting a second build while one is in
 * flight used to mean BOTH ran to completion — two full ~178k-feature graphs
 * built, structured-cloned to the main thread and (partially) ingested by
 * MapLibre back-to-back, doubling the transient allocation burst that sizes
 * the non-decommitting JSC/bmalloc heap. Callers always want only the LATEST
 * build (SurveyLayer discards stale results by token anyway), so while one
 * build is in flight we hold at most one queued request and displace any
 * previously queued one (its promise resolves silently; its sink is never
 * begun, which callers already treat as "superseded, nothing applied").
 */
let queuedNext: { request: WorkerRequest; sink: FeatureStreamSink } | null = null;

/** Post a request to the worker and register its sink. */
function postRequest(w: Worker, request: WorkerRequest, sink: FeatureStreamSink): void {
  const requestId = nextRequestId++;
  pending.set(requestId, sink);
  const tPost = performance.now();
  w.postMessage({ kind: request.kind, requestId, args: request.args });
  // Note: we don't await postMessage — its return is synchronous after the
  // browser schedules the structured-clone, which dominates the cost here.
  recordPerfTiming('buildFeatures postMessage', performance.now() - tPost);
}

/** Single-flight, last-wins scheduling shared by the full build and the narrow
 *  swap: post now if idle, else queue (displacing any previously queued one). */
function scheduleOrQueue(w: Worker, request: WorkerRequest, sink: FeatureStreamSink): void {
  if (pending.size > 0) {
    // A build is in flight: queue this one (last-wins). A previously queued
    // request is displaced — resolve it silently: its sink was never begun,
    // which the SurveyLayer caller already treats as "superseded".
    if (queuedNext) {
      const displaced = queuedNext;
      queuedNext = null;
      displacedSettle(displaced.sink);
    }
    queuedNext = { request, sink };
    return;
  }
  postRequest(w, request, sink);
}

/** After an in-flight build settles, launch the queued one (if any). */
function launchQueued(): void {
  if (!queuedNext || pending.size > 0) return;
  const next = queuedNext;
  queuedNext = null;
  const w = ensureWorker();
  if (!w) {
    // Worker construction failed since the build was queued — surface it;
    // the caller's error path falls back to an inline build.
    next.sink.error(new Error('featuresWorker: worker unavailable for queued build'));
    return;
  }
  postRequest(w, next.request, next.sink);
}

/** Wrap a caller sink so `end`/`error` settle the awaited promise exactly once. */
function makeWrappedSink(sink: FeatureStreamSink, resolve: () => void): FeatureStreamSink {
  let settled = false;
  const settle = (): void => {
    if (!settled) {
      settled = true;
      resolve();
    }
  };
  return {
    begin: () => sink.begin(),
    chunk: (group, payload, palette) => sink.chunk(group, payload, palette),
    end: () => {
      sink.end();
      settle();
    },
    error: (e) => {
      sink.error(e);
      settle();
    },
  };
}

/**
 * Terminate the worker once no build is in flight so its entire JSC heap — the
 * ~178k-feature build burst plus the interner Maps/Sets and station-lookup
 * structures it allocated — is freed back to the allocator in bulk (a whole-VM
 * release the engine actually returns, vs the interleaved-live-object slabs a
 * long-lived worker keeps pinned). The next build recreates it lazily; worker
 * startup is a few ms against a multi-hundred-ms build, and builds are seconds
 * apart (load, zoom-threshold, theme, edits).
 *
 * Guard: if another build is still queued/in-flight (`pending` non-empty) we
 * keep the worker so that build reuses it — only reclaim when fully drained.
 */
function maybeReclaimWorker(): void {
  if (pending.size > 0 || queuedNext) return;
  if (!workerInstance) return;
  workerInstance.terminate();
  workerInstance = null;
}

function ensureWorker(): Worker | null {
  if (workerInstance) return workerInstance;
  if (workerConstructionFailed) return null;

  try {
    // Vite/Webpack `new Worker(new URL(..., import.meta.url), { type: 'module' })`
    // is the recommended pattern; the bundler emits the worker as a separate
    // chunk and rewrites the URL.
    const w = new Worker(new URL('./featuresWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (
      e: MessageEvent<{
        kind: 'begin' | 'chunk' | 'end' | 'error';
        requestId: number;
        colorPalette?: readonly string[];
        group?: SurveyFeatureGroupKey;
        features?: GeoJSON.Feature[];
        vt?: VtLayerData;
        message?: string;
      }>,
    ) => {
      const { kind, requestId } = e.data;
      const sink = pending.get(requestId);
      if (!sink) {
        // Late/duplicate message for a request we already settled — still try
        // to reclaim in case this drained the last in-flight build.
        maybeReclaimWorker();
        return;
      }
      if (kind === 'begin') {
        sink.begin();
      } else if (kind === 'chunk' && e.data.group) {
        // Bulk groups arrive as the compact vt payload (typed arrays moved
        // via the transfer list); others as structured-cloned GeoJSON. The
        // sink applies + drops the payload either way.
        const payload: VtFeatureChunk = e.data.vt
          ? { vt: e.data.vt }
          : { features: e.data.features ?? [] };
        sink.chunk(e.data.group, payload, e.data.colorPalette ?? []);
      } else if (kind === 'end') {
        pending.delete(requestId);
        sink.end();
        launchQueued();
        maybeReclaimWorker();
      } else {
        pending.delete(requestId);
        sink.error(new Error(e.data.message ?? 'unknown worker error'));
        launchQueued();
        maybeReclaimWorker();
      }
    };
    w.onerror = (e) => {
      // Worker-level error (uncaught exception, etc.) — fail all pending and
      // drop the (now-suspect) worker so the next build gets a fresh one.
      const err = new Error(`featuresWorker: ${e.message}`);
      const sinks = [...pending.values()];
      pending.clear();
      if (queuedNext) {
        sinks.push(queuedNext.sink);
        queuedNext = null;
      }
      for (const sink of sinks) sink.error(err);
      if (workerInstance) {
        workerInstance.terminate();
        workerInstance = null;
      }
    };
    workerInstance = w;
    return w;
  } catch (e) {
    // Vite-without-worker, jsdom test env, etc. Fall back to inline.
    console.warn('[featuresWorkerClient] failed to construct Worker, falling back to inline build:', e);
    workerConstructionFailed = true;
    return null;
  }
}

/**
 * Build survey features off the main thread when possible and stream the result
 * to `sink` group-by-group. Falls back to a synchronous in-line build (then a
 * synchronous replay through the same sink) if the Worker isn't available (test
 * envs). The returned promise settles when the stream ends (or errors) so
 * callers can `await` completion without buffering the groups.
 */
export function buildSurveyFeaturesStreamed(args: BuildArgs, sink: FeatureStreamSink): Promise<void> {
  const w = ensureWorker();
  if (!w) {
    // Synchronous fallback: build the full set inline, then replay it through
    // the sink in the same group order the worker uses. No memory win here
    // (single-threaded test path), but behaviour is identical.
    const t0 = performance.now();
    let features;
    try {
      features = buildSurveyFeatures(
        args.surveyData,
        args.loopClosures,
        args.gpsOrigin,
        args.showDepthGradient,
        args.depthRange,
        args.themeColors,
        args.precision,
        args.options,
      );
    } catch (e) {
      sink.error(e instanceof Error ? e : new Error(String(e)));
      return Promise.resolve();
    }
    recordPerfTiming('buildFeatures (inline fallback)', performance.now() - t0);
    // No streaming build here (single-threaded test path), so replay the full
    // set through the sink in group order with the final palette on each chunk.
    sink.begin();
    for (const group of SURVEY_FEATURE_GROUP_ORDER) {
      sink.chunk(group, { features: features[group] }, features.colorPalette);
      features[group] = [];
    }
    sink.end();
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const wrapped = makeWrappedSink(sink, resolve);
    scheduleOrQueue(w, { kind: 'build', args }, wrapped);
  });
}

/**
 * Narrow granularity swap (#mem): rebuild ONLY the shots + stations sources via
 * the direct SoA builder and stream them through the same begin/chunk/end sink
 * contract as {@link buildSurveyFeaturesStreamed}. The ~178k labels / gradients /
 * section-labels / loop-closures are NOT touched (they are invariant to the
 * merged-vs-per-feature granularity), so mode entry/exit is near-instant.
 *
 * Same single-flight last-wins scheduling as the full build (they share the
 * worker + queue), so a later full `update()` or swap supersedes an in-flight
 * one. Falls back to an inline main-thread build when the Worker can't be
 * constructed (test envs) — identical behaviour, no memory win.
 */
export function buildGranularitySwapStreamed(args: GranularitySwapArgs, sink: FeatureStreamSink): Promise<void> {
  const w = ensureWorker();
  if (!w) {
    // Inline fallback: build shots + stations on the main thread and replay the
    // two vt chunks through the sink in group order.
    try {
      const gatedSeverity = args.showIssueSeverity && !!args.issueSeverity;
      const colorCtx: DisplayColorContext = {
        showDepthGradient: args.showDepthGradient,
        depthRange: args.depthRange,
        themeColors: args.themeColors,
        showIssueSeverity: gatedSeverity,
        issueSeverity: args.issueSeverity,
      };
      const built = buildShotStationVt(
        args.surveyData,
        args.gpsOrigin,
        colorCtx,
        args.mergeFeatures,
        makeVtPalette(args.seedPalette),
      );
      sink.begin();
      sink.chunk('shotFeatures', { vt: built.shots }, built.palette);
      sink.chunk('stationFeatures', { vt: built.stations }, built.palette);
      sink.end();
    } catch (e) {
      sink.error(e instanceof Error ? e : new Error(String(e)));
    }
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const wrapped = makeWrappedSink(sink, resolve);
    scheduleOrQueue(w, { kind: 'buildGranularity', args }, wrapped);
  });
}

/**
 * Settle a displaced (superseded) queued build. Its wrapped sink's `end`
 * would run the caller's `sink.end()` — which SurveyLayer guards with a
 * `began` flag (false here, since `begin` never fired), so this is safe and
 * resolves the awaited promise.
 */
function displacedSettle(sink: FeatureStreamSink): void {
  sink.end();
}

/** Tear down the worker. Currently only used from tests. */
export function terminateFeaturesWorker(): void {
  if (workerInstance) {
    workerInstance.terminate();
    workerInstance = null;
  }
  workerConstructionFailed = false;
  const sinks = [...pending.values()];
  pending.clear();
  if (queuedNext) {
    sinks.push(queuedNext.sink);
    queuedNext = null;
  }
  for (const sink of sinks) sink.error(new Error('worker terminated'));
}
