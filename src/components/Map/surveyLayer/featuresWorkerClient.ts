/**
 * Main-thread client for the survey-features Worker.
 *
 * Lazily creates a single Worker (re-used across calls) and routes
 * `build` requests through it, returning a Promise. Falls back to
 * synchronous main-thread build if the Worker can't be constructed
 * (e.g. in test runners that don't support Vite's `?worker` syntax).
 *
 * Tested rough costs on a 75k-shot / 89k-station project:
 *   structured-clone of inputs (Section[] + Station[]):  ~50 ms
 *   buildSurveyFeatures in worker (off main thread):    ~400 ms (parallel)
 *   structured-clone of features back:                   ~80 ms
 * vs synchronous main-thread build of ~450 ms blocking the UI.
 * Net: ~270 ms of main-thread time given back to React + rendering.
 */
import {
  buildSurveyFeatures,
  type BuildSurveyFeaturesOptions,
  type DepthRange,
  type SurveyFeatureSets,
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

/** Worker singleton; created lazily on first use and torn down after each
 *  drained build (see `maybeReclaimWorker`). */
let workerInstance: Worker | null = null;
/** Set only when constructing the Worker THREW (Vite-without-worker, jsdom).
 *  Once construction fails we fall back to inline builds and never retry. A
 *  worker torn down for memory reclaim does NOT set this — it recreates lazily. */
let workerConstructionFailed = false;
/** Pending build requests keyed by id. Resolves when worker posts back. */
const pending = new Map<number, { resolve: (s: SurveyFeatureSets) => void; reject: (e: Error) => void }>();
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
    w.onmessage = (e: MessageEvent<{ kind: 'result' | 'error'; requestId: number; features?: SurveyFeatureSets; message?: string }>) => {
      const { kind, requestId } = e.data;
      const slot = pending.get(requestId);
      if (!slot) {
        // Late/duplicate message for a request we already settled — still try
        // to reclaim in case this drained the last in-flight build.
        maybeReclaimWorker();
        return;
      }
      pending.delete(requestId);
      if (kind === 'result' && e.data.features) {
        slot.resolve(e.data.features);
      } else {
        slot.reject(new Error(e.data.message ?? 'unknown worker error'));
      }
      // The result was structured-cloned onto the main thread before this
      // handler ran, so tearing the worker down now cannot affect `features`.
      maybeReclaimWorker();
    };
    w.onerror = (e) => {
      // Worker-level error (uncaught exception, etc.) — fail all pending and
      // drop the (now-suspect) worker so the next build gets a fresh one.
      const err = new Error(`featuresWorker: ${e.message}`);
      for (const slot of pending.values()) slot.reject(err);
      pending.clear();
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
 * Build survey features off the main thread when possible. Falls back to
 * synchronous in-line build if the Worker isn't available (test envs).
 *
 * The promise resolves with the same `SurveyFeatureSets` shape that the
 * synchronous `buildSurveyFeatures` returns; the caller can swap in/out
 * without changing the downstream `setData` calls.
 */
export function buildSurveyFeaturesAsync(args: BuildArgs): Promise<SurveyFeatureSets> {
  const w = ensureWorker();
  if (!w) {
    // Synchronous fallback. Wrap in a resolved promise to keep the call
    // site uniform; the (small) microtask shift is harmless.
    const t0 = performance.now();
    const features = buildSurveyFeatures(
      args.surveyData,
      args.loopClosures,
      args.gpsOrigin,
      args.showDepthGradient,
      args.depthRange,
      args.themeColors,
      args.precision,
      args.options,
    );
    recordPerfTiming('buildFeatures (inline fallback)', performance.now() - t0);
    return Promise.resolve(features);
  }

  return new Promise<SurveyFeatureSets>((resolve, reject) => {
    const requestId = nextRequestId++;
    pending.set(requestId, { resolve, reject });
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
  for (const slot of pending.values()) slot.reject(new Error('worker terminated'));
  pending.clear();
}
