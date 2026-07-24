import type { GpsOrigin, DecimalPrecision } from '../../../types/config';
import type { LoopClosure, StationRef } from '../../../types/project';
import {
  type SurveyData,
  type SectionMetadata,
  SHOT_FLAG_IS_REFERENCE,
  STATION_FLAG_IS_ZERO_DATUM,
} from '../../../types/survey-data';
import { getDepthColor, getErrorColor } from '../../../utils/colors';
import { metersToMapCoords } from '../../../utils/coordinates';
import type { MapThemeColors } from '../../../utils/themeColors';
import { encodeFeatureId } from '../../../utils/ids';
import {
  formatShotLabel,
  formatStationLabel,
  resolveShotLabelColor,
  resolveStationLabelColor,
  labelColorContextFrom,
  type LabelColorContext,
} from './customRender/labelText';
import {
  commentColorForKey,
  type DepthRange,
  type DisplayColorContext,
  type GhostSectionData,
} from './displayColor';

export interface GhostFeatureSets {
  shotFeatures: GeoJSON.Feature[];
  stationFeatures: GeoJSON.Feature[];
  mergeStationFeatures: GeoJSON.Feature[];
}

export interface SurveyFeatureSets {
  shotFeatures: GeoJSON.Feature[];
  shotGradientFeatures: GeoJSON.Feature[];
  shotLabelFeatures: GeoJSON.Feature[];
  stationFeatures: GeoJSON.Feature[];
  sectionLabelFeatures: GeoJSON.Feature[];
  stationLabelFeatures: GeoJSON.Feature[];
  loopClosureFeatures: GeoJSON.Feature[];
  /** Deduplicated color palette. Shot, gradient-segment and station
   *  features carry a numeric `colorIndex` (stations also `strokeColorIndex`)
   *  into this array instead of a per-feature hex color string. The paint
   *  layer resolves the index with a `match` expression, so colors are
   *  reproduced exactly (a literal lookup, no re-derivation) while ~75k+
   *  shot / ~300-600k gradient / ~89k station features each store a small
   *  integer in place of a freshly-allocated `#rrggbb` string. The palette
   *  is bounded: distinct section colors in normal mode, the (8-bit
   *  quantized) depth-ramp colors in depth mode, or 3 severity colors. */
  colorPalette: string[];
}

/** The GeoJSON-array fields of `SurveyFeatureSets` (everything except the
 *  palette). Used by the chunked worker->main streaming protocol. */
export type SurveyFeatureGroupKey =
  | 'shotFeatures'
  | 'stationFeatures'
  | 'sectionLabelFeatures'
  | 'shotGradientFeatures'
  | 'shotLabelFeatures'
  | 'stationLabelFeatures'
  | 'loopClosureFeatures';

/**
 * Emit order for the chunked worker->main transfer (#mem). Streaming one group
 * at a time means the main thread never holds the full ~178k-feature set as one
 * live JS array in addition to what MapLibre already retains: the transient
 * clone-receive burst that sizes the (non-decommitting) JSC heap is bounded by
 * the largest single group instead of the sum of all of them.
 *
 * The per-feature LABEL groups lead: shot labels, then station labels, right
 * after their geometry. A mid-stream token supersession (a delete's edit +
 * coordinate re-solve + warnings burst) drops whichever group streams last, so
 * the per-station labels must not ride the tail — otherwise a superseded flush
 * lands the shot labels but drops the station labels, and the station labels lag
 * the shots by a reconcile (#customRender station-label converge). Section
 * labels (one per section, coarse) and loop closures (small) trail. This mirrors
 * the emitAndClear sequence in `buildSurveyFeatures`; keep the two in sync.
 */
export const SURVEY_FEATURE_GROUP_ORDER: readonly SurveyFeatureGroupKey[] = [
  'shotFeatures',
  'shotGradientFeatures',
  'shotLabelFeatures',
  'stationFeatures',
  'stationLabelFeatures',
  'sectionLabelFeatures',
  'loopClosureFeatures',
];

/**
 * Optional streaming hook for `buildSurveyFeatures` (#mem). When supplied, each
 * feature group is handed off the moment its build phase finishes — along with
 * a snapshot of the color palette as it stands at that point — and the builder
 * then drops its own reference to that group's array. This keeps the (single-
 * threaded, non-decommitting JSC) heap from ever holding the whole ~178k-feature
 * set at once: the live set is bounded by the largest single group plus the
 * shared O(N) lookup structures, roughly halving the build burst that sizes the
 * committed heap. The palette is append-only, so a later snapshot is always a
 * superset of an earlier one and previously-applied `colorIndex` values stay
 * valid — the caller can adopt each snapshot and repaint without a color flash.
 */
export type SurveyFeatureEmit = (
  group: SurveyFeatureGroupKey,
  features: GeoJSON.Feature[],
  colorPalette: readonly string[],
) => void;

export function normalizeDepthRange(depthRange: DepthRange): DepthRange {
  const minD = Number.isFinite(depthRange.min) ? depthRange.min : 0;
  const maxD = Number.isFinite(depthRange.max) ? depthRange.max : 50;
  return {
    min: Math.min(minD, maxD),
    max: Math.max(minD, maxD),
  };
}

export function buildGhostFeatures(
  data: GhostSectionData | null,
  gpsOrigin: GpsOrigin | null
): GhostFeatureSets {
  const shotFeatures: GeoJSON.Feature[] = [];
  const stationFeatures: GeoJSON.Feature[] = [];
  const mergeStationFeatures: GeoJSON.Feature[] = [];

  if (!data) {
    return { shotFeatures, stationFeatures, mergeStationFeatures };
  }

  for (const shot of data.shots) {
    shotFeatures.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          metersToMapCoords(shot.from.x, shot.from.y, gpsOrigin),
          metersToMapCoords(shot.to.x, shot.to.y, gpsOrigin),
        ],
      },
      properties: { color: data.color },
    });
  }

  for (const station of data.stations) {
    stationFeatures.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: metersToMapCoords(station.x, station.y, gpsOrigin),
      },
      properties: { color: data.color },
    });
  }

  if (data.mergeStation) {
    mergeStationFeatures.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: metersToMapCoords(data.mergeStation.x, data.mergeStation.y, gpsOrigin),
      },
      properties: {},
    });
  }

  return { shotFeatures, stationFeatures, mergeStationFeatures };
}

/**
 * Options for `buildSurveyFeatures`. Splitting these out keeps the
 * signature flat as new toggles are added.
 */
export interface BuildSurveyFeaturesOptions {
  /** Whether to materialize shot-label and station-label features.
   *  Both layers have `minzoom: 14` (so do their comment-overlay layers
   *  that share the same source), and at fit-to-bounds on a large cave
   *  the camera starts well below that. Skipping the ~160 k label
   *  features when they wouldn't render anyway saves ~100 MB main+worker
   *  on a 75 k-shot project. SurveyLayer rebuilds when the camera
   *  crosses the threshold. Defaults to `true` for callers that don't
   *  care (tests, etc.). */
  buildLabels?: boolean;
  /** Issue-severity coloring mode (#22). When true, shots and stations are
   *  colored by validation severity (green/yellow/red) instead of depth /
   *  section color. Mutually exclusive with `showDepthGradient` (the caller
   *  guarantees depth is off in this mode). */
  showIssueSeverity?: boolean;
  /** Per global shot/station severity (0=clear, 1=warning, 2=error), aligned
   *  to this `SurveyData`. Produced by `computeIssueSeverity`. Required when
   *  `showIssueSeverity` is true. */
  issueSeverity?: { shotSeverity: Uint8Array; stationSeverity: Uint8Array } | undefined;
  /** Merge per-shot LineStrings / per-station Points into one MultiLineString /
   *  MultiPoint feature per (sectionId + paint-affecting properties) group
   *  (#mem). MapLibre retains ~4.2 KB per GeoJSON feature (source JSON + tile
   *  features + index), so collapsing 75k shots + 89k stations into ~1-3 groups
   *  per section cuts the retained footprint by an order of magnitude. The
   *  group key holds every property a layer filter or paint expression reads
   *  (shots: `colorIndex`, `isReference`; stations: `colorIndex`,
   *  `strokeColorIndex`, `isZeroDatum`, `allShotsReference`), so a group is
   *  visually homogeneous and the merged feature carries the shared values.
   *  Lines inside a MultiLineString render exactly like separate LineStrings
   *  (caps/joins are per line, so no cross-shot joins appear that per-shot
   *  features didn't have), and circle layers render every coordinate of a
   *  MultiPoint. Merged features carry a sequential numeric `featureId`
   *  (group id) for section-level feature-state; they do NOT carry per-item
   *  `shotId` / `stationIndex` — per-item interactivity is resolved
   *  geometrically (see `geometryIndex.ts`) or via a per-feature rebuild while
   *  a per-feature mode is active. Defaults to `false` (per-feature output). */
  mergeFeatures?: boolean;
}

/** Severity → color (2=error, 1=warning, else clear). */
export function severityColor(themeColors: MapThemeColors, s: number | undefined): string {
  return s === 2
    ? themeColors.severityError
    : s === 1
      ? themeColors.severityWarning
      : themeColors.severityClear;
}

/** The shot's base display color: severity > depth ramp > section color. */
export function resolveShotDisplayColor(
  data: SurveyData,
  sectionColor: string,
  shotGlobalIdx: number,
  ctx: DisplayColorContext,
): string {
  if (ctx.showIssueSeverity && ctx.issueSeverity) {
    return severityColor(ctx.themeColors, ctx.issueSeverity.shotSeverity[shotGlobalIdx]);
  }
  if (ctx.showDepthGradient) {
    const avgDepth = (data.shotDepthIn[shotGlobalIdx]! + data.shotDepthOut[shotGlobalIdx]!) / 2;
    return (
      getDepthColor(
        avgDepth,
        ctx.themeColors.depthShallow,
        ctx.themeColors.depthDeep,
        ctx.depthRange.min,
        ctx.depthRange.max,
      ) ?? sectionColor
    );
  }
  return sectionColor;
}

/**
 * A shot's per-endpoint display colors `[fromColor, toColor]`, used to drive a
 * GPU-interpolated depth gradient along the shot (the custom-render equivalent
 * of the stock `survey-shot-gradients` layer). In depth mode the from-endpoint
 * takes the shot's `depth_in` color and the to-endpoint its `depth_out` color -
 * the exact endpoints the stock gradient ramps between - so the two endpoints
 * are pixel-identical to the stock gradient (the interior differs only in that
 * the GPU lerps in RGB where the stock layer resamples the HSL ramp per
 * sub-segment). Outside depth mode (severity / section color) both endpoints
 * are the flat `resolveShotDisplayColor`, so a caller can always request
 * endpoints without special-casing the mode.
 */
export function resolveShotEndpointColors(
  data: SurveyData,
  sectionColor: string,
  shotGlobalIdx: number,
  ctx: DisplayColorContext,
): [string, string] {
  const base = resolveShotDisplayColor(data, sectionColor, shotGlobalIdx, ctx);
  // Severity fill is a single flat color per shot (mirrors the stock shots
  // layer in severity mode); the gradient sub-layer is depth-only.
  if (ctx.showIssueSeverity && ctx.issueSeverity) return [base, base];
  if (ctx.showDepthGradient) {
    const from =
      getDepthColor(
        data.shotDepthIn[shotGlobalIdx]!,
        ctx.themeColors.depthShallow,
        ctx.themeColors.depthDeep,
        ctx.depthRange.min,
        ctx.depthRange.max,
      ) ?? base;
    const to =
      getDepthColor(
        data.shotDepthOut[shotGlobalIdx]!,
        ctx.themeColors.depthShallow,
        ctx.themeColors.depthDeep,
        ctx.depthRange.min,
        ctx.depthRange.max,
      ) ?? base;
    return [from, to];
  }
  return [base, base];
}

/** The station's fill color: severity > depth ramp > zero-datum > section color. */
export function resolveStationDisplayColor(
  data: SurveyData,
  sectionColor: string,
  stationGlobalIdx: number,
  ctx: DisplayColorContext,
): string {
  if (ctx.showIssueSeverity && ctx.issueSeverity) {
    return severityColor(ctx.themeColors, ctx.issueSeverity.stationSeverity[stationGlobalIdx]);
  }
  const isZeroDatum = (data.stationFlags[stationGlobalIdx]! & STATION_FLAG_IS_ZERO_DATUM) !== 0;
  if (ctx.showDepthGradient) {
    const z = data.stationCoords[stationGlobalIdx * 3 + 2]!;
    return (
      getDepthColor(
        z,
        ctx.themeColors.depthShallow,
        ctx.themeColors.depthDeep,
        ctx.depthRange.min,
        ctx.depthRange.max,
      ) ?? sectionColor
    );
  }
  return isZeroDatum ? ctx.themeColors.zeroDatum : sectionColor;
}

/** The station's stroke color (zero-datum ring in depth mode, else theme stroke). */
export function resolveStationStrokeColor(isZeroDatum: boolean, ctx: DisplayColorContext): string {
  return ctx.showDepthGradient && isZeroDatum
    ? ctx.themeColors.zeroDatum
    : ctx.themeColors.strokeColor;
}

/**
 * SoA-based feature builder. Reads from the typed-array `SurveyData`
 * layout instead of iterating `Section.shots[]` / `Station[]` objects.
 * This is what `SurveyLayer.update()` and the features worker call
 * after Phase A.4.
 *
 * On a 75k-shot project the input no longer involves materialized JS
 * objects per shot/station — the worker receives ~10 transferable
 * typed-array buffers + a small `Map`/`SectionMetadata[]` envelope.
 */
export function buildSurveyFeatures(
  data: SurveyData,
  loopClosures: LoopClosure[] | undefined,
  gpsOrigin: GpsOrigin | null,
  showDepthGradient: boolean,
  depthRange: DepthRange,
  themeColors: MapThemeColors,
  precision?: DecimalPrecision,
  options: BuildSurveyFeaturesOptions = {},
  emit?: SurveyFeatureEmit
): SurveyFeatureSets {
  const buildLabels = options.buildLabels ?? true;
  const mergeFeatures = options.mergeFeatures ?? false;
  // Issue-severity coloring (#22). The context feeds the shared
  // resolve*DisplayColor helpers so single-feature consumers (the interact
  // overlay in SurveyLayer) reproduce these exact colors. The caller
  // guarantees `showDepthGradient` is false in severity mode.
  const showIssueSeverity = (options.showIssueSeverity ?? false) && !!options.issueSeverity;
  const colorCtx: DisplayColorContext = {
    showDepthGradient,
    depthRange,
    themeColors,
    showIssueSeverity,
    issueSeverity: options.issueSeverity,
  };
  // Theme colors (resolved from CSS variables by the caller)
  const depthShallow = themeColors.depthShallow;
  const depthDeep = themeColors.depthDeep;
  const sectionDefault = themeColors.stationDefault;
  // Shared label color inputs (labelText.ts). The custom label path builds the
  // same context via the SAME helper, so shot/station label colors can never
  // drift between paths.
  const labelColorCtx: LabelColorContext = labelColorContextFrom(showDepthGradient, depthRange, themeColors);
  const shotFeatures: GeoJSON.Feature[] = [];
  const shotGradientFeatures: GeoJSON.Feature[] = [];
  const shotLabelFeatures: GeoJSON.Feature[] = [];
  const stationFeatures: GeoJSON.Feature[] = [];
  const sectionLabelFeatures: GeoJSON.Feature[] = [];
  const stationLabelFeatures: GeoJSON.Feature[] = [];
  const loopClosureFeatures: GeoJSON.Feature[] = [];

  // Color palette interner: every distinct color string a shot / gradient /
  // station feature would have carried is stored once here; the feature keeps
  // its index. This collapses the per-feature color from a heap string (freshly
  // allocated per call by getDepthColor in depth mode, so ~1 object per feature)
  // to an inline integer, and lets the paint resolve it with a `match`. The
  // palette is bounded (see SurveyFeatureSets.colorPalette).
  const colorPalette: string[] = [];
  const colorIndexByValue = new Map<string, number>();
  const paletteIndex = (color: string): number => {
    let idx = colorIndexByValue.get(color);
    if (idx === undefined) {
      idx = colorPalette.length;
      colorPalette.push(color);
      colorIndexByValue.set(color, idx);
    }
    return idx;
  };

  // (sectionId, stationIndex) → global station index. Built once,
  // O(stationCount). Replaces the legacy `stationsBySection` sort.
  const stationLookup = new Map<number, Map<number, number>>();
  for (let g = 0; g < data.stationCount; g++) {
    const sid = data.stationSectionIds[g]!;
    const stIdx = data.stationIndices[g]!;
    let inner = stationLookup.get(sid);
    if (!inner) {
      inner = new Map();
      stationLookup.set(sid, inner);
    }
    inner.set(stIdx, g);
  }

  // sectionId → SectionMetadata. Built once, O(sections). The
  // station-features loop below runs ~stationCount times and was
  // previously calling `data.sections.find(...)` per iteration,
  // turning the build into O(stationCount × sectionCount). For the
  // 92.stalx fixture (89 k stations × 14 k sections) that was
  // ~1.3 G comparisons inside the MapLibre features worker — visible
  // as delayed first paint.
  const sectionMetaById = new Map<number, SectionMetadata>();
  for (const s of data.sections) sectionMetaById.set(s.id, s);

  /** Read station (x, y, z) from the SoA. Returns null if invalid global idx. */
  const stationXYZ = (gIdx: number): { x: number; y: number; z: number } => {
    const base = gIdx * 3;
    return {
      x: data.stationCoords[base]!,
      y: data.stationCoords[base + 1]!,
      z: data.stationCoords[base + 2]!,
    };
  };

  // Track stations that have at least one non-reference shot
  // (key: "sectionId:stationIndex").
  const stationsWithNonReferenceShot = new Set<string>();

  // Merged-group accumulators (#mem, options.mergeFeatures). Shot groups are
  // reset per section (the shots loop is section-ordered); station groups are
  // keyed globally with the sectionId in the key (the stations loop is one
  // flat pass in arbitrary section order). Group `featureId`s are sequential
  // ordinals — unique within their source, which is all promoteId needs.
  type ShotGroup = {
    colorIndex: number;
    isReference: boolean;
    commentColor?: string;
    lines: GeoJSON.Position[][];
  };
  type StationGroup = {
    sectionId: number;
    colorIndex: number;
    strokeColorIndex: number;
    isZeroDatum: boolean;
    allShotsReference: boolean;
    commentColor?: string;
    points: GeoJSON.Position[];
  };
  const sectionShotGroups = new Map<string, ShotGroup>();
  const stationGroups = new Map<string, StationGroup>();
  let shotGroupSeq = 0;
  let stationGroupSeq = 0;

  let globalShotOrdinal = 0; // for shot-label `index` property (matches legacy semantics)
  // Move-comment palette (#52): `stationCommentCarry` carries a station's
  // comment text + assigned color from the (always-built) station-circle loop
  // into the (zoom-gated) station-label loop below, so `data.stationComments`
  // is read once per station rather than twice. Only populated when
  // `buildLabels` is true - the label loop is its only reader.
  const stationCommentCarry = new Map<number, { comment: string; color: string }>();

  for (const section of data.sections) {
    const innerStationMap = stationLookup.get(section.id);
    if (!innerStationMap) continue;

    for (let i = 0; i < section.shotCount; i++) {
      const shotGlobalIdx = section.shotOffset + i;
      const fromGlobal = innerStationMap.get(i);
      const toGlobal = innerStationMap.get(i + 1);
      if (fromGlobal === undefined || toGlobal === undefined) continue;

      const shotId = data.shotIds[shotGlobalIdx]!;
      const isReference =
        (data.shotFlags[shotGlobalIdx]! & SHOT_FLAG_IS_REFERENCE) !== 0;
      const azimuth_in = data.shotAzimuthIn[shotGlobalIdx]!;
      const length = data.shotLength[shotGlobalIdx]!;
      const depth_in = data.shotDepthIn[shotGlobalIdx]!;
      const depth_out = data.shotDepthOut[shotGlobalIdx]!;

      if (!isReference) {
        stationsWithNonReferenceShot.add(`${section.id}:${i}`);
        stationsWithNonReferenceShot.add(`${section.id}:${i + 1}`);
      }

      const avgDepth = (depth_in + depth_out) / 2;
      const shotColor = resolveShotDisplayColor(data, section.color, shotGlobalIdx, colorCtx);
      const shotColorIndex = paletteIndex(shotColor);
      const shotFeatureId = encodeFeatureId(section.id, shotId);

      const fromXYZ = stationXYZ(fromGlobal);
      const toXYZ = stationXYZ(toGlobal);

      const shotComment = data.shotComments.get(shotGlobalIdx);
      const shotCommentColor = shotComment
        ? commentColorForKey(`${section.id}:s${shotId}`)
        : undefined;
      const line: GeoJSON.Position[] = [
        metersToMapCoords(fromXYZ.x, fromXYZ.y, gpsOrigin),
        metersToMapCoords(toXYZ.x, toXYZ.y, gpsOrigin),
      ];
      if (mergeFeatures) {
        const key = `${shotColorIndex}|${isReference ? 1 : 0}|${shotCommentColor ?? ''}`;
        let group = sectionShotGroups.get(key);
        if (!group) {
          group = {
            colorIndex: shotColorIndex,
            isReference,
            ...(shotCommentColor ? { commentColor: shotCommentColor } : {}),
            lines: [],
          };
          sectionShotGroups.set(key, group);
        }
        group.lines.push(line);
      } else {
        const properties: Record<string, unknown> = {
          featureId: shotFeatureId,
          sectionId: section.id,
          shotId,
          colorIndex: shotColorIndex,
          isReference,
        };
        if (shotCommentColor) properties.commentColor = shotCommentColor;
        shotFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: line,
          },
          properties,
        });
      }

      if (showDepthGradient) {
        const dx = toXYZ.x - fromXYZ.x;
        const dy = toXYZ.y - fromXYZ.y;
        const depthDelta = depth_out - depth_in;

        // Subdivide by DEPTH change, not line length (#C). The gradient is a
        // color ramp along the shot; a shot's color only varies as fast as its
        // depth does, so a long shallow-slope shot needs few segments while a
        // short steep one needs more - the old length-based count had this
        // exactly backwards and over-subdivided the common (near-flat) shots
        // into 4-12 segments each (300-600k gradient features on 92.stalx).
        //   - |depthDelta| < 0.3 m: 1 segment. The loop below with count 1 spans
        //     the whole shot at midT = 0.5, i.e. the midpoint depth color - the
        //     ramp is visually flat over <0.3 m so a single segment is exact.
        //   - otherwise: ~1 segment per metre of depth change, floored at 2 and
        //     capped at 12 (the same ceiling as before, so steep shots keep
        //     full smoothness).
        const absDelta = Math.abs(depthDelta);
        const segmentCount =
          absDelta < 0.3 ? 1 : Math.max(2, Math.min(12, Math.ceil(absDelta)));

        for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
          const startT = segmentIndex / segmentCount;
          const endT = (segmentIndex + 1) / segmentCount;
          const midT = (startT + endT) / 2;

          const segmentDepth = depth_in + depthDelta * midT;
          const segmentColor =
            getDepthColor(segmentDepth, depthShallow, depthDeep, depthRange.min, depthRange.max) ??
            shotColor;

          shotGradientFeatures.push({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                metersToMapCoords(fromXYZ.x + dx * startT, fromXYZ.y + dy * startT, gpsOrigin),
                metersToMapCoords(fromXYZ.x + dx * endT, fromXYZ.y + dy * endT, gpsOrigin),
              ],
            },
            properties: {
              featureId: shotFeatureId,
              sectionId: section.id,
              shotId,
              segmentIndex,
              colorIndex: paletteIndex(segmentColor),
              isReference,
            },
          });
        }
      }

      // Shot-label feature (zoom-gated; T3a)
      if (buildLabels) {
        const midX = (fromXYZ.x + toXYZ.x) / 2;
        const midY = (fromXYZ.y + toXYZ.y) / 2;
        const labelDepth = (fromXYZ.z + toXYZ.z) / 2;

        const label = formatShotLabel(azimuth_in, length, labelDepth, precision);

        const shotLabelColor = resolveShotLabelColor(avgDepth, labelColorCtx);

        const shotLabelProps: Record<string, unknown> = {
          label,
          index: globalShotOrdinal,
          sectionId: section.id,
          shotId,
          color: shotLabelColor,
          isReference,
        };
        if (shotComment) {
          shotLabelProps.comment = shotComment;
          if (shotCommentColor) shotLabelProps.commentColor = shotCommentColor;
        }
        shotLabelFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: metersToMapCoords(midX, midY, gpsOrigin),
          },
          properties: shotLabelProps,
        });
      }

      globalShotOrdinal++;
    }

    // Emit this section's merged shot groups (#mem): one MultiLineString per
    // (colorIndex, isReference) combination — section-color mode collapses to
    // ~1 feature per section (+1 if it has reference shots).
    if (mergeFeatures && sectionShotGroups.size > 0) {
      for (const group of sectionShotGroups.values()) {
        shotFeatures.push({
          type: 'Feature',
          geometry: { type: 'MultiLineString', coordinates: group.lines },
          properties: {
            featureId: shotGroupSeq++,
            sectionId: section.id,
            colorIndex: group.colorIndex,
            isReference: group.isReference,
            ...(group.commentColor ? { commentColor: group.commentColor } : {}),
          },
        });
      }
      sectionShotGroups.clear();
    }
  }

  // Stream out the shot-derived groups now the shots loop is done (#mem): their
  // colors are all interned, so the palette snapshot is complete for them, and
  // dropping these arrays frees the biggest build burst before the stations
  // loop allocates its own. `emitAndClear` no-ops (keeps the arrays) when no
  // streaming sink was supplied, so the returned set is unchanged for callers.
  const emitAndClear = (group: SurveyFeatureGroupKey, arr: GeoJSON.Feature[]): void => {
    if (!emit) return;
    emit(group, arr, colorPalette);
    arr.length = 0;
  };
  emitAndClear('shotFeatures', shotFeatures);
  emitAndClear('shotGradientFeatures', shotGradientFeatures);
  emitAndClear('shotLabelFeatures', shotLabelFeatures);

  // ─── Station features (per-station circles) ────────────────────
  for (let g = 0; g < data.stationCount; g++) {
    const sectionId = data.stationSectionIds[g]!;
    const stationIndex = data.stationIndices[g]!;
    const section = sectionMetaById.get(sectionId);
    const sectionColor = section?.color ?? sectionDefault;
    const isZeroDatumStation = (data.stationFlags[g]! & STATION_FLAG_IS_ZERO_DATUM) !== 0;
    const xyz = stationXYZ(g);

    // Severity fill overrides depth/section/zero-datum coloring; the
    // zero-datum size/stroke is preserved (isZeroDatum property below).
    const color = resolveStationDisplayColor(data, sectionColor, g, colorCtx);
    const featureStrokeColor = resolveStationStrokeColor(isZeroDatumStation, colorCtx);
    const colorIndex = paletteIndex(color);
    const strokeColorIndex = paletteIndex(featureStrokeColor);
    const allShotsReference = !stationsWithNonReferenceShot.has(`${sectionId}:${stationIndex}`);
    const point = metersToMapCoords(xyz.x, xyz.y, gpsOrigin);
    const stationComment = data.stationComments.get(g);
    const stationCommentColor = stationComment
      ? commentColorForKey(`${sectionId}:st${stationIndex}`)
      : undefined;

    if (mergeFeatures) {
      const key = `${sectionId}|${colorIndex}|${strokeColorIndex}|${isZeroDatumStation ? 1 : 0}|${allShotsReference ? 1 : 0}|${stationCommentColor ?? ''}`;
      let group = stationGroups.get(key);
      if (!group) {
        group = {
          sectionId,
          colorIndex,
          strokeColorIndex,
          isZeroDatum: isZeroDatumStation,
          allShotsReference,
          ...(stationCommentColor ? { commentColor: stationCommentColor } : {}),
          points: [],
        };
        stationGroups.set(key, group);
      }
      group.points.push(point);
    } else {
      stationFeatures.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: point,
        },
        properties: {
          featureId: encodeFeatureId(sectionId, stationIndex),
          sectionId,
          stationIndex,
          isZeroDatum: isZeroDatumStation,
          colorIndex,
          strokeColorIndex,
          allShotsReference,
          ...(stationCommentColor ? { commentColor: stationCommentColor } : {}),
        },
      });
    }
    if (buildLabels && stationComment) {
      stationCommentCarry.set(g, { comment: stationComment, color: stationCommentColor! });
    }

  }
  // Emit merged station groups (#mem): one MultiPoint per (sectionId +
  // paint-affecting props) combination, in first-seen order.
  if (mergeFeatures && stationGroups.size > 0) {
    for (const group of stationGroups.values()) {
      stationFeatures.push({
        type: 'Feature',
        geometry: { type: 'MultiPoint', coordinates: group.points },
        properties: {
          featureId: stationGroupSeq++,
          sectionId: group.sectionId,
          isZeroDatum: group.isZeroDatum,
          colorIndex: group.colorIndex,
          strokeColorIndex: group.strokeColorIndex,
          allShotsReference: group.allShotsReference,
          ...(group.commentColor ? { commentColor: group.commentColor } : {}),
        },
      });
    }
    stationGroups.clear();
  }
  emitAndClear('stationFeatures', stationFeatures);

  // ─── Section labels ────────────────────────────────────────────
  for (const section of data.sections) {
    const innerStationMap = stationLookup.get(section.id);
    if (!innerStationMap || innerStationMap.size === 0) continue;

    // Prefer the first non-reference station for label placement so it
    // doesn't float mid-air when reference shots are hidden.
    let anchorGlobalIdx: number | undefined;
    let anchorStationIdx = Infinity;
    let foundNonRef = false;
    for (const [stIdx, gIdx] of innerStationMap.entries()) {
      const hasNonRef = stationsWithNonReferenceShot.has(`${section.id}:${stIdx}`);
      // Once we see a non-reference station, only consider those.
      if (foundNonRef && !hasNonRef) continue;
      if (hasNonRef && !foundNonRef) {
        foundNonRef = true;
        anchorStationIdx = Infinity; // restart min search among non-ref
      }
      if (stIdx < anchorStationIdx) {
        anchorStationIdx = stIdx;
        anchorGlobalIdx = gIdx;
      }
    }
    if (anchorGlobalIdx === undefined) continue;

    const xyz = stationXYZ(anchorGlobalIdx);
    const allStationsReference = !foundNonRef;
    sectionLabelFeatures.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: metersToMapCoords(xyz.x, xyz.y, gpsOrigin),
      },
      properties: {
        name: section.name,
        color: section.color,
        sectionId: section.id,
        allStationsReference,
      },
    });
  }
  // ─── Station labels (zoom-gated; T3a) ─────────────────────────
  // Built after the section-label loop but emitted BEFORE it (see the emit
  // ordering at the end of this function). The per-station labels must stream
  // adjacent to the shot labels and never last: a delete fires a burst of
  // superseding flushes (edit + coordinate re-solve + warnings), and a
  // mid-stream token supersession drops whichever label group streams last.
  // When station labels rode last, a superseded flush landed the shot labels
  // early but dropped the station labels, so station labels only refreshed from
  // the rare settling flush and visibly lagged the shots by a reconcile. Emitted
  // early they track the shot labels frame-for-frame (#customRender station-label
  // converge).
  if (buildLabels) {
    // Per-section min station_index (== "is first in section" predicate)
    const sectionMinIndices = new Map<number, number>();
    for (let g = 0; g < data.stationCount; g++) {
      const sid = data.stationSectionIds[g]!;
      const idx = data.stationIndices[g]!;
      const cur = sectionMinIndices.get(sid);
      if (cur === undefined || idx < cur) sectionMinIndices.set(sid, idx);
    }

    for (let g = 0; g < data.stationCount; g++) {
      const sectionId = data.stationSectionIds[g]!;
      const stationIndex = data.stationIndices[g]!;
      const isFirstInSection = stationIndex === sectionMinIndices.get(sectionId);
      const xyz = stationXYZ(g);

      const stationLabelColor = resolveStationLabelColor(xyz.z, labelColorCtx);

      const stationLabelProps: Record<string, unknown> = {
        label: formatStationLabel(stationIndex),
        stationIndex,
        sectionId,
        globalOrdinal: g,
        isFirstInSection,
        color: stationLabelColor,
        allShotsReference: !stationsWithNonReferenceShot.has(`${sectionId}:${stationIndex}`),
      };
      const carriedComment = stationCommentCarry.get(g);
      if (carriedComment) {
        stationLabelProps.comment = carriedComment.comment;
        stationLabelProps.commentColor = carriedComment.color;
      }
      stationLabelFeatures.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: metersToMapCoords(xyz.x, xyz.y, gpsOrigin),
        },
        properties: stationLabelProps,
      });
    }
  }

  // ─── Loop closures ────────────────────────────────────────────
  if (loopClosures && loopClosures.length > 0) {
    /** Look up station coords via (sectionId, stationIndex) — used by
     *  loop-closure endpoints that reference stations by ref. */
    const findStationXYZByRef = (ref: StationRef): { x: number; y: number; z: number } | undefined => {
      const gIdx = stationLookup.get(ref.section_id)?.get(ref.station_index);
      return gIdx === undefined ? undefined : stationXYZ(gIdx);
    };

    for (const closure of loopClosures) {
      const a = findStationXYZByRef(closure.station_a);
      const b = findStationXYZByRef(closure.station_b);
      if (a && b) {
        loopClosureFeatures.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              metersToMapCoords(a.x, a.y, gpsOrigin),
              metersToMapCoords(b.x, b.y, gpsOrigin),
            ],
          },
          properties: {
            stationA: `${closure.station_a.section_id}:${closure.station_a.station_index}`,
            stationB: `${closure.station_b.section_id}:${closure.station_b.station_index}`,
            sectionIdA: closure.station_a.section_id,
            sectionIdB: closure.station_b.section_id,
            errorPercentage: closure.error_percentage,
            misclosureDistance: closure.misclosure_distance,
            pathLength: closure.path_length,
            color: getErrorColor(closure.error_percentage),
          },
        });
      }
    }
  }
  // Label emit order: station labels FIRST (right after the shot-derived groups
  // and the station circles), then section labels, then loop closures. Streaming
  // the per-station labels before the section labels / loop closures keeps them
  // off the drop-prone tail of a superseded flush, so they converge with the
  // shot labels instead of a reconcile behind (#customRender station-label
  // converge). The build order above is unchanged; only the emit sequence the
  // streamed apply consumes differs. Keep in sync with SURVEY_FEATURE_GROUP_ORDER.
  emitAndClear('stationLabelFeatures', stationLabelFeatures);
  emitAndClear('sectionLabelFeatures', sectionLabelFeatures);
  emitAndClear('loopClosureFeatures', loopClosureFeatures);

  return {
    shotFeatures,
    shotGradientFeatures,
    shotLabelFeatures,
    stationFeatures,
    sectionLabelFeatures,
    stationLabelFeatures,
    loopClosureFeatures,
    colorPalette,
  };
}
