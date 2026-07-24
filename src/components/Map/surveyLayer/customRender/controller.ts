/**
 * Controller wiring the custom-render prototype into SurveyLayer (#customRender).
 *
 * Keeps SurveyLayer.tsx to a few integration lines: SurveyLayer constructs one
 * of these, calls `sync(...)` after each geometry flush, and `destroy()` on
 * teardown. Everything else — reading the gate, building buffers from SoA,
 * resolving colors, adding/removing the custom layer, and toggling the stock
 * bulk layers' visibility — lives here.
 *
 * Flag ON  : add the custom layer before `survey-shots` (above basemap/ghosts,
 *            below labels/overlays) and hide the stock shots / shot-gradient /
 *            stations layers. Labels, interact overlay, drag-preview stay stock.
 * Flag OFF : remove the custom layer, restore the stock layers' visibility.
 *
 * Hit-testing does NOT depend on the stock layers: candidate-section discovery
 * runs against the SoA geometry index (SurveyLayer.hitCandidateSections ->
 * geometryIndex.sectionsIntersectingBox), so hiding the stock layers leaves
 * hover / select / station+segment move fully working. Labels, overlays, and
 * the vector-tile publish path are likewise untouched.
 */
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { GpsOrigin } from '../../../../types/config';
import type { SurveyData } from '../../../../types/survey-data';
import { metersToMapCoords } from '../../../../utils/coordinates';
import { debugLog } from '../../../../utils/debugLog';
import { FEATURE_ID_STRIDE } from '../../../../utils/ids';
import type { DisplayColorContext } from '../features';
import { lngLatToMercator } from '../vectorTileData';
import { computeMercatorAnchor } from './mercator';
import {
  buildStationLookup,
  computeStationAllReference,
  projectStationsRel,
  buildLineBuffers,
  buildCircleBuffers,
  computeLineDim,
  computeCircleDim,
  recomputeLineSection,
  recomputeStation,
  recomputeSectionAllReference,
  recomputeLineColors,
  recomputeCircleColors,
  type StationRel,
  type CustomRenderExclusion,
  type LineSectionInputs,
  type CircleStationInputs,
} from './tessellate';
import { makeColorResolvers } from './colorResolvers';
import { planIncrementalUpdate, planColorOnlyUpdate, coalesceVertexRuns } from './incremental';
import { SurveyCustomLayer, type CustomRenderData } from './surveyCustomLayer';
import {
  readCustomRenderGate,
  CUSTOM_RENDER_SYNC_HOOK,
} from './gate';

/** Stock bulk layers hidden while the custom layer is on. */
const HIDDEN_STOCK_LAYERS = ['survey-shots', 'survey-shot-gradients', 'survey-stations'] as const;

/**
 * Defer a fail-safe restore off MapLibre's render stack. A self-disable fires
 * from inside `render()`, so we must NOT mutate the style synchronously there.
 * rAF (preferred) runs it next frame; microtask / setTimeout are non-DOM
 * fallbacks (test/node). Injectable via controller options for deterministic tests.
 */
function defaultScheduleRestore(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else if (typeof queueMicrotask === 'function') queueMicrotask(fn);
  else setTimeout(fn, 0);
}

export interface SurveyCustomControllerOptions {
  /** Override how the fail-safe restore is deferred off the render stack.
   *  Defaults to {@link defaultScheduleRestore}; tests inject an inline runner. */
  scheduleRestore?: (fn: () => void) => void;
  /**
   * Re-sync the layer from CURRENT geometry, backing the runtime
   * `__stalagmightSyncCustomRender` hook. When provided, the hook calls this
   * instead of replaying the controller's cached `lastParams` snapshot: after a
   * project switch the snapshot is a previous project's geometry, so replaying
   * it strands the custom layer on stale data (fewer shots than the store).
   * SurveyLayer supplies a resync that reads the store, so a manual re-sync
   * always converges to the loaded project. Absent (unit tests): fall back to
   * the cached snapshot.
   */
  resync?: () => void;
  /**
   * Notified whenever the custom layer's active (drawing) state flips. `true`
   * once the layer is added AND drawing (stock bulk layers hidden); `false` on
   * teardown, gate-off, or a fail-safe self-disable. SurveyLayer uses this to
   * stop publishing the stock bulk shot/station/gradient vector tiles while the
   * custom layer covers them, and to re-publish them from cached SoA when the
   * custom layer goes away (#customRender / #mem). Never fires for a failed
   * enable (the layer that could not draw leaves `active` false, so the stock
   * pipeline must stay published).
   */
  onActiveChange?: (active: boolean) => void;
}

export interface CustomSyncParams {
  surveyData: SurveyData;
  gpsOrigin: GpsOrigin | null;
  colorCtx: DisplayColorContext;
  /** CSS-pixel style sizes (mirror the stock layers' visual weights). */
  shotWidthPx: number;
  stationRadiusPx: number;
  stationStrokePx: number;
  /** Features to omit from the buffers, mirroring the stock bulk layers'
   *  move-drag setFilter exclusions. Absent / undefined = draw everything. */
  exclude?: CustomRenderExclusion | undefined;
}

export type { CustomRenderExclusion } from './tessellate';

/**
 * Current dimming set mirroring the stock move-tool paint state (#customRender).
 * `anchoredSectionIds` dims every station + shot of those sections (move-segment,
 * SurveyLayer.setAnchoredSections); the immovable `featureId` sets dim specific
 * stations / shots (move-station / move-shot, SurveyLayer.setImmovableFeatures).
 * `featureId = sectionId * FEATURE_ID_STRIDE + stationIndex | shotId`, matching
 * the stock layers' `['get','featureId']` matching. Held on the controller so a
 * layer re-create (re-enable / re-sync) re-applies it during the next build.
 */
export interface CustomDimState {
  anchoredSectionIds: ReadonlySet<number>;
  immovableStationFeatureIds: ReadonlySet<number>;
  immovableShotFeatureIds: ReadonlySet<number>;
}

const EMPTY_DIM: CustomDimState = {
  anchoredSectionIds: new Set<number>(),
  immovableStationFeatureIds: new Set<number>(),
  immovableShotFeatureIds: new Set<number>(),
};

/** No features hidden (drag inactive): the zero-cost default for the hide flag. */
const EMPTY_EXCLUSION: CustomRenderExclusion = {};

/** No sections emphasized: the default for each highlight-source set. */
const EMPTY_HIGHLIGHT: ReadonlySet<number> = new Set<number>();

/** Emphasis levels stored in the per-vertex highlight flag, mirroring the stock
 *  feature-state bumps. Hover wins over selection when a section is in both
 *  (matches the stock paint case order: `hover` before `selected`). */
const HIGHLIGHT_HOVER = 2;
const HIGHLIGHT_SELECT = 1;
const HIGHLIGHT_NONE = 0;

export class SurveyCustomController {
  private readonly map: MaplibreMap;
  private readonly layerId: string;
  private layer: SurveyCustomLayer | null = null;
  private active = false;
  private lastParams: CustomSyncParams | null = null;
  private hookInstalled = false;
  private readonly scheduleRestore: (fn: () => void) => void;
  /** Fresh-geometry re-sync backing the runtime hook; see options.resync. */
  private readonly resync: (() => void) | undefined;
  /** Active-state transition callback; see options.onActiveChange. */
  private readonly onActiveChange: ((active: boolean) => void) | undefined;
  /** Guards handleSelfDisable against re-entrancy while a restore is pending. */
  private selfDisableScheduled = false;
  /** True only for the duration of {@link teardown}. The teardown republishes
   *  the stock bulk sources synchronously (so the survey never blanks between
   *  the custom layer going away and the stock geometry coming back), and that
   *  republish mirrors back into {@link syncCustomRender} -> {@link sync}. While
   *  the gate is still ON (a fail-safe self-disable, not a gate opt-out) an
   *  unguarded re-entrant sync() would see `!active` and RE-ENABLE the very
   *  layer we are removing. This flag makes that re-entrant sync() a no-op. */
  private tearingDown = false;
  /** Display toggles mirroring the stock layers' setShowShots /
   *  setShowStations / setShowReferenceShots. Held on the controller so they
   *  survive a layer re-create (enable re-applies them to the fresh layer). */
  private shotsVisible = true;
  private stationsVisible = true;
  private referenceShotsVisible = true;
  /** Anchored / immovable dim set applied to every build; survives re-enable. */
  private dimState: CustomDimState = EMPTY_DIM;
  /** Features hidden for the active move drag (drag begin/end). Applied as the
   *  per-vertex hide flag over the FULL buffers instead of omitting features (a
   *  rebuild), and re-applied on every build so a mid-drag flush stays hidden. */
  private hideState: CustomRenderExclusion = EMPTY_EXCLUSION;
  /** The three section-emphasis sources, merged per section into a highlight
   *  LEVEL (hover 2 > selection 1 > none 0) applied as the per-vertex highlight
   *  flag and re-applied on every build so a mid-interaction flush stays
   *  emphasized. `segmentHoverState` is the Move-Segment connected set
   *  (setHighlight); `sectionHoverState` is single-section / panel-row hover
   *  (setSectionHover); `sectionSelectState` is the selected section
   *  (setSectionSelect). Hover (segment or section) both map to level 2, matching
   *  the stock `hover` feature-state; selection maps to level 1 (stock
   *  `selected`). Anchored sections are excluded from segment-hover upstream. */
  private segmentHoverState: ReadonlySet<number> = EMPTY_HIGHLIGHT;
  private sectionHoverState: ReadonlySet<number> = EMPTY_HIGHLIGHT;
  private sectionSelectState: ReadonlySet<number> = EMPTY_HIGHLIGHT;
  /** Cached build products backing the cheap dim-only refresh (setDimming),
   *  the drag hide refresh (setDragHide), and the incremental edit path: the
   *  last CustomRenderData (its per-vertex arrays are rewritten in place) plus
   *  the station lookup / anchor-relative positions / all-reference flags /
   *  survey the recomputes need. */
  private lastData: CustomRenderData | null = null;
  private lastLookup: Map<number, Map<number, number>> | null = null;
  private lastSurveyData: SurveyData | null = null;
  private lastStationRel: StationRel | null = null;
  private lastAllReference: Float32Array | null = null;

  constructor(
    map: MaplibreMap,
    layerId = 'survey-custom-render',
    opts: SurveyCustomControllerOptions = {},
  ) {
    this.map = map;
    this.layerId = layerId;
    this.scheduleRestore = opts.scheduleRestore ?? defaultScheduleRestore;
    this.resync = opts.resync;
    this.onActiveChange = opts.onActiveChange;
    this.installHook();
  }

  /** Re-evaluate the gate and apply/refresh or tear down the custom layer. */
  sync(params: CustomSyncParams): void {
    // Re-entrancy guard: teardown() republishes stock synchronously, which
    // mirrors back here. Record the params (so a later real sync diffs against
    // the latest inputs) but do nothing else, or we would re-enable mid-teardown.
    if (this.tearingDown) {
      this.lastParams = params;
      return;
    }
    const prevParams = this.lastParams;
    this.lastParams = params;
    const enabled = readCustomRenderGate();
    if (!enabled) {
      if (this.active) this.disable();
      return;
    }
    // Fast paths (active layer + a prior snapshot to diff against): a geometry
    // edit that left the SoA layout unchanged re-emits just the changed sections;
    // a pure global recolor (overlay / theme / depth-mode toggle) with unchanged
    // geometry re-uploads just the two color buffers. Either beats a full rebuild.
    if (this.active && this.layer && prevParams) {
      if (this.tryIncremental(prevParams, params)) return;
      if (this.tryColorOnly(prevParams, params)) return;
    }
    const data = this.build(params);
    if (!this.active) this.enable(data);
    else this.layer?.update(data);
  }

  /** Mirror setShowShots: show/hide the custom-rendered shots. Cheap - flips a
   *  draw flag + repaints, no buffer rebuild. */
  setShotsVisible(visible: boolean): void {
    this.shotsVisible = visible;
    this.layer?.setShotsVisible(visible);
    if (this.active) this.map.triggerRepaint();
  }

  /** Mirror setShowStations: show/hide the custom-rendered stations. */
  setStationsVisible(visible: boolean): void {
    this.stationsVisible = visible;
    this.layer?.setStationsVisible(visible);
    if (this.active) this.map.triggerRepaint();
  }

  /** Mirror setShowReferenceShots: hide/show reference shots + all-reference
   *  stations via the shader uniform (instant, like the stock setFilter - no
   *  buffer rebuild). */
  setReferenceShotsVisible(visible: boolean): void {
    this.referenceShotsVisible = visible;
    this.layer?.setReferenceShotsVisible(visible);
    if (this.active) this.map.triggerRepaint();
  }

  /** Set the active flag, firing {@link onActiveChange} only on a real change so
   *  SurveyLayer can drop / re-publish the stock bulk sources in lockstep. */
  private setActive(v: boolean): void {
    if (this.active === v) return;
    this.active = v;
    this.onActiveChange?.(v);
  }

  private enable(data: CustomRenderData): void {
    if (!this.map.getStyle) return;
    // addLayer triggers layer.onAdd synchronously; the layer may disable itself
    // there (no WebGL2, shader compile/link failure) and would draw NOTHING.
    const layer = new SurveyCustomLayer(this.layerId, data, (reason) =>
      this.handleSelfDisable(reason),
    );
    // Re-apply display toggles to the fresh layer (a re-enable starts a new
    // SurveyCustomLayer whose flags default to "show everything").
    layer.setShotsVisible(this.shotsVisible);
    layer.setStationsVisible(this.stationsVisible);
    layer.setReferenceShotsVisible(this.referenceShotsVisible);
    const beforeId = this.map.getLayer('survey-shots') ? 'survey-shots' : undefined;
    this.map.addLayer(layer, beforeId);
    if (layer.isDisabled()) {
      // FAIL-SAFE: never hide the stock layers behind a layer that can't draw.
      // Remove the dead layer, ensure the stock survey stays visible, and warn
      // ungated so the failure is diagnosable in a production build.
      const reason = layer.getDisabledReason() ?? 'unknown';
      console.warn(
        `[customRender] custom layer failed to initialize (${reason}); ` +
          'keeping stock survey layers visible',
      );
      if (this.map.getLayer?.(this.layerId)) this.map.removeLayer(this.layerId);
      this.setStockVisibility('visible');
      this.layer = null;
      this.setActive(false);
      return;
    }
    this.layer = layer;
    this.setStockVisibility('none');
    this.setActive(true);
    // Ungated lifecycle log (one-shot): gate state + buffer counts.
    console.info('[customRender] enabled; stock survey layers hidden', {
      shotSegments: data.line.segmentCount,
      stations: data.circle.stationCount,
      bytes: data.line.byteLength + data.circle.byteLength,
    });
    this.map.triggerRepaint();
  }

  private disable(): void {
    this.teardown();
    // Ungated lifecycle log (one-shot): gate flipped off / controller torn down.
    console.info('[customRender] disabled; stock survey layers restored');
  }

  /** Remove the custom layer and un-hide the stock layers. No logging (callers
   *  log with their own context). Safe when already inactive.
   *
   *  Ordering matters: un-hide the stock layers and let `setActive(false)` drive
   *  their SYNCHRONOUS republish from cache (see SurveyLayer.onCustomActiveChange)
   *  BEFORE removing the custom layer. Otherwise there is a frame where the
   *  custom layer is gone and the stock geometry has not come back yet (the stock
   *  bulk sources were emptied at enable time), so the whole survey blanks until
   *  an async worker build lands. The {@link tearingDown} guard keeps the
   *  republish's mirror-back into {@link sync} from re-enabling this layer. */
  private teardown(): void {
    this.tearingDown = true;
    try {
      this.setStockVisibility('visible');
      this.setActive(false);
      if (this.map.getLayer?.(this.layerId)) this.map.removeLayer(this.layerId);
      this.layer = null;
    } finally {
      this.tearingDown = false;
    }
    this.map.triggerRepaint();
  }

  /**
   * The custom layer hit a GL error mid-render and disabled itself. This fires
   * INSIDE MapLibre's frame (from the layer's render()), so mutating the style
   * now is unsafe. Warn ungated with the error code and DEFER the stock-layer
   * restore off the render stack. Idempotent + re-entrancy-safe.
   */
  private handleSelfDisable(reason: string): void {
    if (!this.active || this.selfDisableScheduled) return;
    this.selfDisableScheduled = true;
    console.warn(
      `[customRender] custom layer self-disabled (${reason}); restoring stock survey layers`,
    );
    this.scheduleRestore(() => {
      this.selfDisableScheduled = false;
      if (this.active) this.teardown();
    });
  }

  private setStockVisibility(v: 'none' | 'visible'): void {
    for (const id of HIDDEN_STOCK_LAYERS) {
      if (this.map.getLayer?.(id)) {
        try {
          this.map.setLayoutProperty(id, 'visibility', v);
        } catch {
          // Layer may be mid-teardown; ignore.
        }
      }
    }
  }

  /** DEVICE-pixel style sizes for a params set (mirror the stock visual weights).
   *  Shared by build() and the incremental path so a size-only change (no vertex
   *  edit) still reaches the shader uniforms. */
  private sizeFields(params: CustomSyncParams): Pick<
    CustomRenderData,
    'lineHalfWidthPx' | 'circleRadiusPx' | 'circleStrokePx' | 'aaPx'
  > {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    return {
      lineHalfWidthPx: (params.shotWidthPx / 2) * dpr,
      circleRadiusPx: params.stationRadiusPx * dpr,
      circleStrokePx: params.stationStrokePx * dpr,
      aaPx: dpr,
    };
  }

  /** Build the GPU-ready buffers from SoA, resolving colors + anchor. */
  private build(params: CustomSyncParams): CustomRenderData {
    const t0 = performance.now();
    const { surveyData, gpsOrigin, colorCtx } = params;
    const [anchorX, anchorY] = computeMercatorAnchor(surveyData, gpsOrigin);
    const stationRel = projectStationsRel(surveyData, gpsOrigin, anchorX, anchorY);
    const lookup = buildStationLookup(surveyData);
    const res = makeColorResolvers(surveyData, colorCtx);
    const allReference = computeStationAllReference(surveyData, lookup);
    // Apply the current dim + drag-hide sets (null on the hot path so the dim /
    // hide attributes stay all-zero without per-item predicate calls).
    const dims = this.hasDimming() ? this.dimPredicates(surveyData) : null;
    const hides = this.hasHide() ? this.hidePredicates(surveyData) : null;
    const highlights = this.hasHighlight() ? this.highlightPredicates(surveyData) : null;
    const line = buildLineBuffers(
      surveyData, stationRel, lookup, res.colorForShot, params.exclude,
      res.useDepthEndpoints ? res.colorForShotEndpoints : undefined,
      dims?.dimForShot, hides?.hideForShot, highlights?.highlightForShot,
    );
    const circle = buildCircleBuffers(
      surveyData, stationRel, res.fillForStation, res.strokeForStation, params.exclude, allReference,
      dims?.dimForStation, hides?.hideForStation, highlights?.highlightForStation,
    );

    const data: CustomRenderData = { anchorX, anchorY, line, circle, ...this.sizeFields(params) };

    const totalBytes = line.byteLength + circle.byteLength;
    debugLog('[customRender] build', {
      ms: +(performance.now() - t0).toFixed(1),
      shotSegments: line.segmentCount,
      stations: circle.stationCount,
      lineMB: +(line.byteLength / 1048576).toFixed(2),
      circleMB: +(circle.byteLength / 1048576).toFixed(2),
      totalMB: +(totalBytes / 1048576).toFixed(2),
    });
    // Cache products so setDimming / setDragHide / the incremental edit path can
    // recompute just the affected arrays in place.
    this.lastData = data;
    this.lastLookup = lookup;
    this.lastSurveyData = surveyData;
    this.lastStationRel = stationRel;
    this.lastAllReference = allReference;
    return data;
  }

  /** True when some anchored section or immovable feature is currently set. */
  private hasDimming(): boolean {
    return (
      this.dimState.anchoredSectionIds.size > 0 ||
      this.dimState.immovableStationFeatureIds.size > 0 ||
      this.dimState.immovableShotFeatureIds.size > 0
    );
  }

  /** Per-station / per-shot dim predicates for the current {@link dimState}:
   *  a feature dims when its section is anchored OR its featureId is immovable. */
  private dimPredicates(surveyData: SurveyData): {
    dimForStation: (g: number) => boolean;
    dimForShot: (globalShotIdx: number, sectionId: number) => boolean;
  } {
    const { anchoredSectionIds, immovableStationFeatureIds, immovableShotFeatureIds } = this.dimState;
    return {
      dimForStation: (g: number): boolean => {
        const sid = surveyData.stationSectionIds[g]!;
        return (
          anchoredSectionIds.has(sid) ||
          (immovableStationFeatureIds.size > 0 &&
            immovableStationFeatureIds.has(sid * FEATURE_ID_STRIDE + surveyData.stationIndices[g]!))
        );
      },
      dimForShot: (globalShotIdx: number, sectionId: number): boolean =>
        anchoredSectionIds.has(sectionId) ||
        (immovableShotFeatureIds.size > 0 &&
          immovableShotFeatureIds.has(sectionId * FEATURE_ID_STRIDE + surveyData.shotIds[globalShotIdx]!)),
    };
  }

  /** True when a drag is hiding some feature (drag active). */
  private hasHide(): boolean {
    return (
      (this.hideState.sectionIds?.size ?? 0) > 0 ||
      (this.hideState.stationGlobalIndices?.size ?? 0) > 0 ||
      (this.hideState.shotGlobalIndices?.size ?? 0) > 0
    );
  }

  /** Per-station / per-shot hide predicates for the current {@link hideState}:
   *  a feature hides when its section, its global station index, or its global
   *  shot index is in the drag-exclusion set. Mirrors the build-time exclusion
   *  skip so a marked vertex collapses exactly where an omitted one would vanish. */
  private hidePredicates(surveyData: SurveyData): {
    hideForStation: (g: number) => boolean;
    hideForShot: (globalShotIdx: number, sectionId: number) => boolean;
  } {
    const { sectionIds, stationGlobalIndices, shotGlobalIndices } = this.hideState;
    return {
      hideForStation: (g: number): boolean =>
        stationGlobalIndices?.has(g) === true ||
        sectionIds?.has(surveyData.stationSectionIds[g]!) === true,
      hideForShot: (globalShotIdx: number, sectionId: number): boolean =>
        shotGlobalIndices?.has(globalShotIdx) === true || sectionIds?.has(sectionId) === true,
    };
  }

  /** True when any emphasis source has a section (hover / selection active). */
  private hasHighlight(): boolean {
    return (
      this.segmentHoverState.size > 0 ||
      this.sectionHoverState.size > 0 ||
      this.sectionSelectState.size > 0
    );
  }

  /** Merged emphasis level for one section: hover (2) if in either hover source,
   *  else selection (1) if selected, else none (0). Hover wins over selection,
   *  matching the stock paint case order (`hover` before `selected`). */
  private highlightLevel(sectionId: number): number {
    if (this.segmentHoverState.has(sectionId) || this.sectionHoverState.has(sectionId)) {
      return HIGHLIGHT_HOVER;
    }
    if (this.sectionSelectState.has(sectionId)) return HIGHLIGHT_SELECT;
    return HIGHLIGHT_NONE;
  }

  /** Per-station / per-shot highlight predicates resolving the merged emphasis
   *  level for a feature's section (0 none, 1 selection, 2 hover). */
  private highlightPredicates(surveyData: SurveyData): {
    highlightForStation: (g: number) => number;
    highlightForShot: (globalShotIdx: number, sectionId: number) => number;
  } {
    return {
      highlightForStation: (g: number): number =>
        this.highlightLevel(surveyData.stationSectionIds[g]!),
      highlightForShot: (_globalShotIdx: number, sectionId: number): number =>
        this.highlightLevel(sectionId),
    };
  }

  /**
   * Update the anchored / immovable dim set (SurveyLayer.setAnchoredSections /
   * setImmovableFeatures). Rare (fires on move-tool activation, not per frame),
   * so it takes the cheap path: recompute ONLY the two per-vertex dim arrays
   * from the cached SoA + exclusion and re-upload just those GPU buffers, no
   * reprojection or color packing. State is stored regardless so the next full
   * build (geometry flush / drag / re-enable) reproduces it.
   */
  setDimming(state: CustomDimState): void {
    this.dimState = state;
    if (!this.active || !this.layer || !this.lastData || !this.lastLookup || !this.lastSurveyData) {
      return;
    }
    const survey = this.lastSurveyData;
    const exclude = this.lastParams?.exclude;
    const { dimForStation, dimForShot } = this.dimPredicates(survey);
    const lineDim = computeLineDim(survey, this.lastLookup, dimForShot, exclude);
    const circleDim = computeCircleDim(survey, dimForStation, exclude);
    // Keep the cached buffers coherent so a later context restore / re-upload
    // (update()) carries the dim state without a fresh setDimming.
    this.lastData.line.dim = lineDim;
    this.lastData.circle.dim = circleDim;
    this.layer.updateDim(lineDim, circleDim);
    this.map.triggerRepaint();
  }

  /**
   * Point the custom layer at (or off, with null) the active drag's hidden
   * feature set (SurveyLayer.setDragExclusion). The cheap drag-begin/end path:
   * the buffers keep every feature, so this recomputes ONLY the two per-vertex
   * hide arrays from the cached SoA and re-uploads just those GPU buffers -
   * no reprojection, color packing, or full rebuild. State is stored regardless
   * so the next full build (mid-drag flush / re-enable) reproduces it.
   */
  setDragHide(exclusion: CustomRenderExclusion | null): void {
    this.hideState = exclusion ?? EMPTY_EXCLUSION;
    if (!this.active || !this.layer || !this.lastData || !this.lastLookup || !this.lastSurveyData) {
      return;
    }
    const survey = this.lastSurveyData;
    // The live drag path never uses a build-time exclusion, so the hide arrays
    // span the full (uncompacted) buffers; computeLine/CircleDim double as the
    // per-vertex flag builders for any predicate.
    const lineHide = this.hasHide()
      ? computeLineDim(survey, this.lastLookup, this.hidePredicates(survey).hideForShot)
      : new Float32Array(this.lastData.line.vertexCount);
    const circleHide = this.hasHide()
      ? computeCircleDim(survey, this.hidePredicates(survey).hideForStation)
      : new Float32Array(this.lastData.circle.vertexCount);
    this.lastData.line.hide = lineHide;
    this.lastData.circle.hide = circleHide;
    this.layer.updateHide(lineHide, circleHide);
    this.map.triggerRepaint();
  }

  /**
   * Emphasize the hovered connected segment (SurveyLayer.setHoveredSegment for
   * the Move Segment tool) at hover level. Pass an empty array to clear (hover
   * leaves geometry / drag begins). See {@link refreshHighlight}.
   */
  setHighlight(sectionIds: readonly number[]): void {
    this.segmentHoverState = sectionIds.length > 0 ? new Set(sectionIds) : EMPTY_HIGHLIGHT;
    this.refreshHighlight();
  }

  /**
   * Emphasize the single hovered / panel-row-hovered section at hover level
   * (SurveyLayer.setHoveredSection). Empty array clears. The stock renderer used
   * the same `hover` feature-state the Move-Segment set does, so both feed the
   * hover level here. See {@link refreshHighlight}.
   */
  setSectionHover(sectionIds: readonly number[]): void {
    this.sectionHoverState = sectionIds.length > 0 ? new Set(sectionIds) : EMPTY_HIGHLIGHT;
    this.refreshHighlight();
  }

  /**
   * Emphasize the selected section at the (smaller) selection level
   * (SurveyLayer.setSelectedSection). Empty array clears. When a section is both
   * selected and hovered the merge yields hover level (hover wins). See
   * {@link refreshHighlight}.
   */
  setSectionSelect(sectionIds: readonly number[]): void {
    this.sectionSelectState = sectionIds.length > 0 ? new Set(sectionIds) : EMPTY_HIGHLIGHT;
    this.refreshHighlight();
  }

  /** Clear every emphasis source (segment hover, section hover, selection) in one
   *  refresh. Cheaper + clearer than three empty setters at a clear-all site. */
  clearHighlights(): void {
    this.segmentHoverState = EMPTY_HIGHLIGHT;
    this.sectionHoverState = EMPTY_HIGHLIGHT;
    this.sectionSelectState = EMPTY_HIGHLIGHT;
    this.refreshHighlight();
  }

  /**
   * Recompute + re-upload the two per-vertex highlight-level arrays from the
   * merged emphasis sources. Sibling of {@link setDimming}: the cheap
   * per-interaction path recomputes ONLY the highlight arrays from the cached SoA
   * (computeLine/CircleDim double as the per-vertex flag builders for any
   * predicate) and re-uploads just those GPU buffers - no reprojection or color
   * packing. State is stored on the source sets regardless so the next full build
   * reproduces it.
   */
  private refreshHighlight(): void {
    if (!this.active || !this.layer || !this.lastData || !this.lastLookup || !this.lastSurveyData) {
      return;
    }
    const survey = this.lastSurveyData;
    const exclude = this.lastParams?.exclude;
    const lineHighlight = this.hasHighlight()
      ? computeLineDim(survey, this.lastLookup, this.highlightPredicates(survey).highlightForShot, exclude)
      : new Float32Array(this.lastData.line.vertexCount);
    const circleHighlight = this.hasHighlight()
      ? computeCircleDim(survey, this.highlightPredicates(survey).highlightForStation, exclude)
      : new Float32Array(this.lastData.circle.vertexCount);
    this.lastData.line.highlight = lineHighlight;
    this.lastData.circle.highlight = circleHighlight;
    this.layer.updateHighlight(lineHighlight, circleHighlight);
    this.map.triggerRepaint();
  }

  /**
   * Try to apply an edit incrementally (only the changed sections' vertex
   * ranges) instead of a full rebuild. Returns false to fall back to build().
   * Requires an active layer with cached products; `planIncrementalUpdate` gates
   * on layout / color-global / anchor / gps stability (see incremental.ts).
   */
  private tryIncremental(prevParams: CustomSyncParams, params: CustomSyncParams): boolean {
    const prev = this.lastSurveyData;
    const layer = this.layer;
    const line = this.lastData?.line;
    const circle = this.lastData?.circle;
    const rel = this.lastStationRel;
    const allRef = this.lastAllReference;
    const lookup = this.lastLookup;
    if (!prev || !layer || !this.lastData || !line || !circle || !rel || !allRef || !lookup) return false;
    // A build-time exclusion (tests) compacts the buffers, breaking the g↦[4g]
    // station map the incremental path relies on; only the live (full) path is
    // eligible.
    if (prevParams.exclude || params.exclude) return false;
    const next = params.surveyData;
    const plan = planIncrementalUpdate(
      prev, next, prevParams.colorCtx, params.colorCtx,
      prevParams.gpsOrigin, params.gpsOrigin, this.lastData.anchorX, this.lastData.anchorY,
    );
    if (!plan) return false;

    // Reproject moved stations in place (same anchor by the plan's gate).
    const { anchorX, anchorY } = this.lastData;
    for (const g of plan.reprojectStationGlobals) {
      const ll = metersToMapCoords(next.stationCoords[g * 3]!, next.stationCoords[g * 3 + 1]!, params.gpsOrigin);
      const [mx, my] = lngLatToMercator(ll[0], ll[1]);
      rel[g * 2] = mx - anchorX;
      rel[g * 2 + 1] = my - anchorY;
    }

    const res = makeColorResolvers(next, params.colorCtx);
    const dims = this.hasDimming() ? this.dimPredicates(next) : null;
    const hides = this.hasHide() ? this.hidePredicates(next) : null;
    const highlights = this.hasHighlight() ? this.highlightPredicates(next) : null;
    const lineInputs: LineSectionInputs = {
      colorForShot: res.colorForShot,
      colorForShotEndpoints: res.useDepthEndpoints ? res.colorForShotEndpoints : undefined,
      dimForShot: dims?.dimForShot,
      hideForShot: hides?.hideForShot,
      highlightForShot: highlights?.highlightForShot,
    };
    const circleInputs: CircleStationInputs = {
      fillForStation: res.fillForStation,
      strokeForStation: res.strokeForStation,
      dimForStation: dims?.dimForStation,
      hideForStation: hides?.hideForStation,
      highlightForStation: highlights?.highlightForStation,
    };

    // Re-emit each dirty section's line range + its stations (all-reference
    // first, since a station read depends on it), collecting station slots.
    const circleSlots: number[] = [];
    for (const si of plan.dirtySectionIdxs) {
      const section = next.sections[si]!;
      recomputeSectionAllReference(next, lookup, section, allRef);
      const inner = lookup.get(section.id);
      if (inner) {
        for (const g of inner.values()) {
          recomputeStation(circle, g, next, rel, circleInputs, allRef[g]!);
          circleSlots.push(g);
        }
      }
      recomputeLineSection(line, si, next, rel, lookup, lineInputs);
    }

    // Sub-upload: one contiguous line range per section; coalesced station runs.
    for (const si of plan.dirtySectionIdxs) {
      const segStart = line.sectionRanges[si * 2]!;
      const segCount = line.sectionRanges[si * 2 + 1]!;
      layer.uploadLineVertexRange(segStart * 4, segCount * 4);
    }
    circleSlots.sort((a, b) => a - b);
    for (const [vStart, vCount] of coalesceVertexRuns(circleSlots, 4)) {
      layer.uploadCircleVertexRange(vStart, vCount);
    }

    // Refresh caches + size uniforms (a size-only change needs no upload).
    Object.assign(this.lastData, this.sizeFields(params));
    this.lastSurveyData = next;
    this.map.triggerRepaint();
    return true;
  }

  /**
   * Try to apply a pure global recolor (analytical-overlay enter/exit, theme
   * change, depth / severity toggle) as a color-only re-upload instead of a full
   * rebuild. The geometry is unchanged, so this recomputes ONLY the four color
   * arrays via the shared resolvers (in the SAME SoA order the full build wrote
   * them, so the bytes are identical to a rebuild) and re-uploads just the two
   * color buffers. Returns false to fall back to build() when the change is not
   * color-only (see {@link planColorOnlyUpdate}) or a build-time exclusion is
   * active (compaction breaks the g↦[4g] map, as for {@link tryIncremental}).
   */
  private tryColorOnly(prevParams: CustomSyncParams, params: CustomSyncParams): boolean {
    const prev = this.lastSurveyData;
    const layer = this.layer;
    const line = this.lastData?.line;
    const circle = this.lastData?.circle;
    const lookup = this.lastLookup;
    if (!prev || !layer || !this.lastData || !line || !circle || !lookup) return false;
    if (prevParams.exclude || params.exclude) return false;
    const next = params.surveyData;
    if (
      !planColorOnlyUpdate(
        prev, next, prevParams.colorCtx, params.colorCtx,
        prevParams.gpsOrigin, params.gpsOrigin, this.lastData.anchorX, this.lastData.anchorY,
      )
    ) {
      return false;
    }

    const res = makeColorResolvers(next, params.colorCtx);
    recomputeLineColors(
      line, next, lookup, res.colorForShot,
      res.useDepthEndpoints ? res.colorForShotEndpoints : undefined,
    );
    recomputeCircleColors(circle, next, res.fillForStation, res.strokeForStation);
    layer.updateColors(line.colorFrom, line.colorTo, circle.fill, circle.stroke);

    // Cache coherence: geometry buffers are untouched; refresh the survey ref +
    // size uniforms (a size-only change rides here with no extra upload).
    Object.assign(this.lastData, this.sizeFields(params));
    this.lastSurveyData = next;
    this.map.triggerRepaint();
    return true;
  }

  private installHook(): void {
    if (this.hookInstalled || typeof window === 'undefined') return;
    (window as unknown as Record<string, unknown>)[CUSTOM_RENDER_SYNC_HOOK] = () =>
      this.runSyncHook();
    this.hookInstalled = true;
  }

  /**
   * Body of the runtime `__stalagmightSyncCustomRender` hook. Prefer a
   * fresh-geometry resync (SurveyLayer reads the store) so a manual re-sync
   * after a project switch never rebuilds from a stale `lastParams` snapshot;
   * fall back to the snapshot only when no resync was wired (unit tests).
   */
  private runSyncHook(): void {
    if (this.resync) this.resync();
    else if (this.lastParams) this.sync(this.lastParams);
  }

  destroy(): void {
    if (this.active) this.disable();
    if (this.hookInstalled && typeof window !== 'undefined') {
      delete (window as unknown as Record<string, unknown>)[CUSTOM_RENDER_SYNC_HOOK];
      this.hookInstalled = false;
    }
    this.lastParams = null;
  }
}
