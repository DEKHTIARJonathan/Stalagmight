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
  type SurveyFeatureGroupKey,
} from './features';
import type { LoopClosure } from '../../../types/project';
import type { SurveyData } from '../../../types/survey-data';
import type { GpsOrigin, DecimalPrecision } from '../../../types/config';
import type { MapThemeColors } from '../../../utils/themeColors';
import { recordPerfTiming } from '../../../utils/memoryProbe';

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

/**
 * Streaming reply consumer. `begin` fires once (reset), then `chunk` once per
 * group as its build phase finishes — carrying a snapshot of the append-only
 * color palette at that point — then exactly one of `end` (success) or `error`.
 * The caller MUST drop its reference to each chunk's features after `chunk`
 * returns so the memory win holds.
 */
export interface FeatureStreamSink {
  begin(): void;
  chunk(group: SurveyFeatureGroupKey, features: GeoJSON.Feature[], colorPalette: readonly string[]): void;
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
 *  `end`/`error` message (or a worker-level error). */
const pending = new Map<number, FeatureStreamSink>();
let nextRequestId = 0;

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
  if (pending.size > 0) return;
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
        // The chunk's features were structured-cloned onto the main thread
        // before this handler ran; the sink applies + drops them.
        sink.chunk(e.data.group, e.data.features ?? [], e.data.colorPalette ?? []);
      } else if (kind === 'end') {
        pending.delete(requestId);
        sink.end();
        maybeReclaimWorker();
      } else {
        pending.delete(requestId);
        sink.error(new Error(e.data.message ?? 'unknown worker error'));
        maybeReclaimWorker();
      }
    };
    w.onerror = (e) => {
      // Worker-level error (uncaught exception, etc.) — fail all pending and
      // drop the (now-suspect) worker so the next build gets a fresh one.
      const err = new Error(`featuresWorker: ${e.message}`);
      const sinks = [...pending.values()];
      pending.clear();
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
      sink.chunk(group, features[group], features.colorPalette);
      features[group] = [];
    }
    sink.end();
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const requestId = nextRequestId++;
    // Wrap the caller's sink so end/error also settle this promise exactly once.
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    pending.set(requestId, {
      begin: () => sink.begin(),
      chunk: (group, features, palette) => sink.chunk(group, features, palette),
      end: () => {
        sink.end();
        settle();
      },
      error: (e) => {
        sink.error(e);
        settle();
      },
    });
    const tPost = performance.now();
    w.postMessage({ kind: 'build', requestId, args });
    // Note: we don't await postMessage — its return is synchronous after the
    // browser schedules the structured-clone, which dominates the cost here.
    recordPerfTiming('buildFeatures postMessage', performance.now() - tPost);
  });
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
  for (const sink of sinks) sink.error(new Error('worker terminated'));
}
