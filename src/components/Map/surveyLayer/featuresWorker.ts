/**
 * Web Worker entry point for off-thread `buildSurveyFeatures`.
 *
 * Main thread → worker: `{ kind: 'build', requestId, args }`
 * Worker → main thread: `{ kind: 'result', requestId, features }` on success,
 *                       `{ kind: 'error', requestId, message }` on failure.
 *
 * The request/response pairing lets us share a single worker instance across
 * concurrent `update()` calls; the client wrapper matches results by id.
 */
import {
  buildSurveyFeatures,
  type BuildSurveyFeaturesOptions,
  type DepthRange,
  type SurveyFeatureGroupKey,
} from './features';
import type { LoopClosure } from '../../../types/project';
import type { SurveyData } from '../../../types/survey-data';
import type { GpsOrigin, DecimalPrecision } from '../../../types/config';
import type { MapThemeColors } from '../../../utils/themeColors';
import {
  vtLinesFromFeatures,
  vtPointsFromFeatures,
  vtTransferables,
  type VtLayerData,
} from './vectorTileData';

interface BuildArgs {
  surveyData: SurveyData;
  loopClosures: LoopClosure[] | undefined;
  gpsOrigin: GpsOrigin | null;
  showDepthGradient: boolean;
  depthRange: DepthRange;
  themeColors: MapThemeColors;
  precision: DecimalPrecision | undefined;
  options: BuildSurveyFeaturesOptions;
}

interface BuildMessage {
  kind: 'build';
  requestId: number;
  args: BuildArgs;
}

/** Streaming reply protocol (#mem). One `begin` (reset), then one `chunk` per
 *  feature group as its build phase finishes — each carries a snapshot of the
 *  append-only color palette so the main thread can adopt it and repaint with
 *  no flash — then one `end`. `buildSurveyFeatures` frees each group array right
 *  after it is posted, so the worker's build burst never holds the full
 *  ~178k-feature set and the main thread applies + drops one group at a time. */
interface BeginMessage {
  kind: 'begin';
  requestId: number;
}

interface ChunkMessage {
  kind: 'chunk';
  requestId: number;
  group: SurveyFeatureGroupKey;
  /** GeoJSON payload for non-bulk groups (loop closures). */
  features?: GeoJSON.Feature[];
  /** Compact typed-array payload for the bulk groups (#mem): converted here
   *  in the worker so the ~14k-170k-feature GeoJSON graph never structured-
   *  clones to the main thread; the arrays move via the transfer list. */
  vt?: VtLayerData;
  colorPalette: readonly string[];
}

interface EndMessage {
  kind: 'end';
  requestId: number;
}

interface ErrorMessage {
  kind: 'error';
  requestId: number;
  message: string;
}

type IncomingMessage = BuildMessage;
type OutgoingMessage = BeginMessage | ChunkMessage | EndMessage | ErrorMessage;

/** Bulk groups converted to the compact vector-tile payload (#mem). Loop
 *  closures (small) keep the GeoJSON path. Keep in sync with
 *  SurveyLayer.VT_GROUP_KIND. */
const VT_GROUP_KIND: Partial<Record<SurveyFeatureGroupKey, 'line' | 'point'>> = {
  shotFeatures: 'line',
  shotGradientFeatures: 'line',
  stationFeatures: 'point',
  sectionLabelFeatures: 'point',
  shotLabelFeatures: 'point',
  stationLabelFeatures: 'point',
};

self.onmessage = (e: MessageEvent<IncomingMessage>) => {
  const msg = e.data;
  if (msg.kind !== 'build') return;

  try {
    const begin: OutgoingMessage = { kind: 'begin', requestId: msg.requestId };
    self.postMessage(begin);
    // Stream each group out of `buildSurveyFeatures` as its build phase finishes.
    // postMessage's structured clone is synchronous, so the array is fully
    // serialized before the builder drops its reference (it clears the array
    // right after this returns) - the worker never holds the full feature set.
    buildSurveyFeatures(
      msg.args.surveyData,
      msg.args.loopClosures,
      msg.args.gpsOrigin,
      msg.args.showDepthGradient,
      msg.args.depthRange,
      msg.args.themeColors,
      msg.args.precision,
      msg.args.options,
      (group, features, colorPalette) => {
        const vtKind = VT_GROUP_KIND[group];
        if (vtKind) {
          const vt = vtKind === 'line' ? vtLinesFromFeatures(features) : vtPointsFromFeatures(features);
          const chunk: OutgoingMessage = {
            kind: 'chunk',
            requestId: msg.requestId,
            group,
            vt,
            colorPalette,
          };
          self.postMessage(chunk, { transfer: vtTransferables(vt) });
          return;
        }
        const chunk: OutgoingMessage = {
          kind: 'chunk',
          requestId: msg.requestId,
          group,
          features,
          colorPalette,
        };
        self.postMessage(chunk);
      },
    );
    const end: OutgoingMessage = { kind: 'end', requestId: msg.requestId };
    self.postMessage(end);
  } catch (e) {
    const out: OutgoingMessage = {
      kind: 'error',
      requestId: msg.requestId,
      message: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
    self.postMessage(out);
  }
};

// Required for TS to treat this as a module (otherwise `self.onmessage`
// types fall back to the wrong DOM globals).
export {};
