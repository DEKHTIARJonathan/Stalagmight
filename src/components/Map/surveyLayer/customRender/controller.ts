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
import type { SurveyData, SectionMetadata } from '../../../../types/survey-data';
import { STATION_FLAG_IS_ZERO_DATUM } from '../../../../types/survey-data';
import { debugLog } from '../../../../utils/debugLog';
import { FEATURE_ID_STRIDE } from '../../../../utils/ids';
import {
  resolveShotDisplayColor,
  resolveShotEndpointColors,
  resolveStationDisplayColor,
  resolveStationStrokeColor,
  type DisplayColorContext,
} from '../features';
import { packCssColor, type Rgba8 } from './colorPack';
import { computeMercatorAnchor } from './mercator';
import {
  buildStationLookup,
  computeStationAllReference,
  projectStationsRel,
  buildLineBuffers,
  buildCircleBuffers,
  computeLineDim,
  computeCircleDim,
  type CustomRenderExclusion,
} from './tessellate';
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
  /** Guards handleSelfDisable against re-entrancy while a restore is pending. */
  private selfDisableScheduled = false;
  /** Display toggles mirroring the stock layers' setShowShots /
   *  setShowStations / setShowReferenceShots. Held on the controller so they
   *  survive a layer re-create (enable re-applies them to the fresh layer). */
  private shotsVisible = true;
  private stationsVisible = true;
  private referenceShotsVisible = true;
  /** Anchored / immovable dim set applied to every build; survives re-enable. */
  private dimState: CustomDimState = EMPTY_DIM;
  /** Cached build products backing the cheap dim-only refresh (setDimming):
   *  the last CustomRenderData (its dim arrays are rewritten in place) plus the
   *  station lookup + survey the line-dim recompute needs. */
  private lastData: CustomRenderData | null = null;
  private lastLookup: Map<number, Map<number, number>> | null = null;
  private lastSurveyData: SurveyData | null = null;

  constructor(
    map: MaplibreMap,
    layerId = 'survey-custom-render',
    opts: SurveyCustomControllerOptions = {},
  ) {
    this.map = map;
    this.layerId = layerId;
    this.scheduleRestore = opts.scheduleRestore ?? defaultScheduleRestore;
    this.resync = opts.resync;
    this.installHook();
  }

  /** Re-evaluate the gate and apply/refresh or tear down the custom layer. */
  sync(params: CustomSyncParams): void {
    this.lastParams = params;
    const enabled = readCustomRenderGate();
    if (!enabled) {
      if (this.active) this.disable();
      return;
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
      this.active = false;
      return;
    }
    this.layer = layer;
    this.setStockVisibility('none');
    this.active = true;
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
   *  log with their own context). Safe when already inactive. */
  private teardown(): void {
    if (this.map.getLayer?.(this.layerId)) this.map.removeLayer(this.layerId);
    this.layer = null;
    this.setStockVisibility('visible');
    this.active = false;
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

  /** Build the GPU-ready buffers from SoA, resolving colors + anchor. */
  private build(params: CustomSyncParams): CustomRenderData {
    const t0 = performance.now();
    const { surveyData, gpsOrigin, colorCtx } = params;
    const [anchorX, anchorY] = computeMercatorAnchor(surveyData, gpsOrigin);
    const stationRel = projectStationsRel(surveyData, gpsOrigin, anchorX, anchorY);
    const lookup = buildStationLookup(surveyData);

    const sectionById = new Map<number, SectionMetadata>();
    for (const s of surveyData.sections) sectionById.set(s.id, s);
    const stationDefault = colorCtx.themeColors.stationDefault;

    // Small append cache: the palette of distinct colors is tiny vs the vertex
    // count, so parse each CSS color once.
    const packCache = new Map<string, Rgba8>();
    const pack = (css: string): Rgba8 => {
      let v = packCache.get(css);
      if (!v) {
        v = packCssColor(css);
        packCache.set(css, v);
      }
      return v;
    };

    const colorForShot = (shotGlobalIdx: number, sectionId: number): Rgba8 => {
      const sectionColor = sectionById.get(sectionId)?.color ?? stationDefault;
      return pack(resolveShotDisplayColor(surveyData, sectionColor, shotGlobalIdx, colorCtx));
    };
    // Depth mode only: per-endpoint colors so the GPU interpolates the shot's
    // depth ramp natively (the stock survey-shot-gradients equivalent). In
    // section-color / severity mode this resolver is not passed, so lines stay
    // flat and byte-identical to before.
    const colorForShotEndpoints = (
      shotGlobalIdx: number,
      sectionId: number,
    ): readonly [Rgba8, Rgba8] => {
      const sectionColor = sectionById.get(sectionId)?.color ?? stationDefault;
      const [from, to] = resolveShotEndpointColors(surveyData, sectionColor, shotGlobalIdx, colorCtx);
      return [pack(from), pack(to)];
    };
    const fillForStation = (g: number): Rgba8 => {
      const sectionId = surveyData.stationSectionIds[g]!;
      const sectionColor = sectionById.get(sectionId)?.color ?? stationDefault;
      return pack(resolveStationDisplayColor(surveyData, sectionColor, g, colorCtx));
    };
    const strokeForStation = (g: number): Rgba8 => {
      const isZeroDatum = (surveyData.stationFlags[g]! & STATION_FLAG_IS_ZERO_DATUM) !== 0;
      return pack(resolveStationStrokeColor(isZeroDatum, colorCtx));
    };

    const useDepthEndpoints = colorCtx.showDepthGradient && !colorCtx.showIssueSeverity;
    const allReference = computeStationAllReference(surveyData, lookup);
    // Apply the current anchored/immovable dim set (undefined on the no-dim hot
    // path so the dim attribute stays all-zero without per-item predicate calls).
    const dims = this.hasDimming() ? this.dimPredicates(surveyData) : null;
    const line = buildLineBuffers(
      surveyData, stationRel, lookup, colorForShot, params.exclude,
      useDepthEndpoints ? colorForShotEndpoints : undefined,
      dims?.dimForShot,
    );
    const circle = buildCircleBuffers(
      surveyData, stationRel, fillForStation, strokeForStation, params.exclude, allReference,
      dims?.dimForStation,
    );

    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const data: CustomRenderData = {
      anchorX,
      anchorY,
      line,
      circle,
      lineHalfWidthPx: (params.shotWidthPx / 2) * dpr,
      circleRadiusPx: params.stationRadiusPx * dpr,
      circleStrokePx: params.stationStrokePx * dpr,
      aaPx: dpr,
    };

    const totalBytes = line.byteLength + circle.byteLength;
    debugLog('[customRender] build', {
      ms: +(performance.now() - t0).toFixed(1),
      shotSegments: line.segmentCount,
      stations: circle.stationCount,
      lineMB: +(line.byteLength / 1048576).toFixed(2),
      circleMB: +(circle.byteLength / 1048576).toFixed(2),
      totalMB: +(totalBytes / 1048576).toFixed(2),
      distinctColors: packCache.size,
    });
    // Cache products so setDimming can recompute just the dim arrays in place.
    this.lastData = data;
    this.lastLookup = lookup;
    this.lastSurveyData = surveyData;
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
