/**
 * Controller wiring the custom-render LABEL pass into SurveyLayer (#customRender
 * labels, Phase 2). Sibling of `controller.ts` (geometry); intentionally a
 * SEPARATE class + custom layer so labels enable / fail / rebuild independently
 * of the geometry layer (design §8: "the two custom layers can fail
 * independently"). SurveyLayer constructs one of these alongside the geometry
 * controller and calls `sync(...)` after each flush.
 *
 * GATE COMPOSITION: labels ride the custom pipeline, so this activates only when
 * BOTH the geometry gate (`readCustomRenderGate`) AND the labels gate
 * (`readCustomLabelsGate`) are on. With either off the stock label layers stay
 * live and this is a no-op — the gate-OFF path is byte-identical to before.
 *
 * SCOPE (Phase 3): ALL FIVE kinds — shot labels, station labels, section names,
 * station comments, shot comments. It builds every kind's descriptors, hides the
 * five stock text layers while active, and drives each kind's visibility via a
 * shader uniform (the `setShow*` setters). Reference-shot hiding and the
 * move-comment palette tint are reproduced from the flags + `commentColor`
 * resolver already threaded through the tessellator.
 *
 * SCOPE (Phase 4): the build is now VIEWPORT-SCOPED with screen-space COLLISION.
 * Only anchors inside the padded viewport build; below the label-build zoom
 * (13.5/13 hysteresis) only the cheap section names build (down to their own
 * minzoom 10), below 10 nothing. A greedy grid declutters the on-screen set
 * (`labelCollide.ts`), baking `LABEL_FLAG.HIDE` into the fresh buffer. The build
 * runs synchronously on every `sync()` (edits stay immediate — the whole point of
 * this project) AND on camera settle via a controller-owned moveend/zoomend
 * listener, coalesced to one rebuild per settle and never fired mid-animation.
 * A per-kind toggle stays a pure uniform flip (no rebuild) as in Phase 3; its
 * effect on the collision candidate set lands at the next build (camera settle /
 * edit) rather than immediately — see the note on {@link setKindVisible}.
 *
 * FONT READINESS: the SDF atlas needs the bundled font loaded (async). If a sync
 * arrives before the font resolves, it is remembered and built once the font is
 * ready (then `triggerRepaint`); every later sync is synchronous.
 */
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { GpsOrigin, DecimalPrecision } from '../../../../types/config';
import type { SurveyData } from '../../../../types/survey-data';
import type { MapThemeColors } from '../../../../utils/themeColors';
import { debugLog } from '../../../../utils/debugLog';
import { FEATURE_ID_STRIDE } from '../../../../utils/ids';
import { commentColorForKey } from '../features';
import { lngLatToMercator } from '../vectorTileData';
import { computeMercatorAnchor } from './mercator';
import {
  buildLabelDescriptors,
  shapeDescriptors,
  buildLabelBuffersFromShaped,
  buildLabelFlags,
  type LabelDescriptor,
  type ViewportRel,
} from './labelTessellate';
import { shapedExtent, type ExtentEm, type ShapedLabel } from './labelLayout';
import { collideLabels } from './labelCollide';
import { labelColorContextFrom } from './labelText';
import { LABEL_KIND, LABEL_KIND_COUNT, LABEL_FLAG, type LabelKind } from './labelShaders';
import { LABEL_KIND_STYLE } from './labelStyle';
import { packCssColor, type Rgba8 } from './colorPack';
import type { CustomDimState } from './controller';
import type { CustomRenderExclusion } from './tessellate';
import {
  GlyphAtlas,
  ensureLabelFont,
  createTinySdfRasterizer,
  canRasterize,
  type GlyphRasterizer,
} from './glyphAtlas';
import { resolveHaloColors, type LabelStyleInputs } from './labelStyle';
import { SurveyCustomLabelLayer, type LabelRenderData } from './surveyCustomLabelLayer';
import { readCustomLabelsGate, CUSTOM_LABELS_SYNC_HOOK } from './labelsGate';
import { readCustomRenderGate } from './gate';

/** The stock text layer each kind replaces — suppressed while the custom label
 *  layer is active, restored (to the kind's desired toggle) when it goes away. */
const STOCK_LABEL_LAYER_BY_KIND: Record<LabelKind, string> = {
  [LABEL_KIND.SHOT_LABEL]: 'survey-shot-labels',
  [LABEL_KIND.STATION_LABEL]: 'survey-station-labels',
  [LABEL_KIND.SECTION_NAME]: 'survey-labels',
  [LABEL_KIND.STATION_COMMENT]: 'survey-station-comments',
  [LABEL_KIND.SHOT_COMMENT]: 'survey-shot-comments',
};

/** Same off-the-render-stack deferral as the geometry controller. Used both for
 *  the fail-safe restore and to coalesce camera-settle viewport rebuilds. */
function defaultScheduleRestore(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else if (typeof queueMicrotask === 'function') queueMicrotask(fn);
  else setTimeout(fn, 0);
}

// ─── Phase 4: viewport scoping + camera-triggered rebuild ─────────────────────

/** Zoom hysteresis for the EXPENSIVE label kinds (shot/station labels + comments),
 *  matching the stock `SurveyLayer.LABEL_BUILD_ZOOM` / `LABEL_DROP_ZOOM` +
 *  `labelBuildDecision.ts`: build once past 13.5, drop only once below 13. Below
 *  the band those kinds build NOTHING. */
const LABEL_BUILD_ZOOM = 13.5;
const LABEL_DROP_ZOOM = 13;
/** Section names are cheap (1 per section) and orienting, so they follow their
 *  own `minzoom` (10, the stock `survey-labels` layer) rather than the expensive
 *  band — they still show at z10..13.5. Below 10 the shader hides them anyway. */
const SECTION_NAME_MIN_ZOOM = LABEL_KIND_STYLE[LABEL_KIND.SECTION_NAME].minzoom;
/** Padded-viewport margin as a fraction of the viewport span, applied to EACH
 *  side (0.5 → the build box is 2× the viewport per axis, a half-screen margin
 *  all round). Generous enough that a modest pan does not reach blank areas
 *  before the next camera-settle rebuild; tunable. */
const VIEWPORT_PADDING = 0.5;

/** Below the expensive band but at/above section minzoom: only section names. */
const SECTION_ONLY_KINDS: ReadonlySet<LabelKind> = new Set([LABEL_KIND.SECTION_NAME]);
/** Below section minzoom: nothing builds. */
const NO_KINDS: ReadonlySet<LabelKind> = new Set();

// ─── Phase 5: dim + drag-hide interaction state ──────────────────────────────

/** Anchored / immovable dim set — the SAME shape the geometry controller takes
 *  ({@link CustomDimState}), so SurveyLayer pushes one state to both. */
const EMPTY_DIM: CustomDimState = {
  anchoredSectionIds: new Set<number>(),
  immovableStationFeatureIds: new Set<number>(),
  immovableShotFeatureIds: new Set<number>(),
};
/** Drag-exclusion set — the SAME shape the geometry controller takes
 *  ({@link CustomRenderExclusion}); dragged features' labels hide. */
const EMPTY_EXCLUSION: CustomRenderExclusion = {};

/** The padded viewport rect (anchor-relative mercator) + a projector from
 *  anchor-relative mercator to CSS screen px — both derived from ONE
 *  `map.getBounds()` read. `null` when the map cannot supply bounds / a canvas
 *  (unit-test fakes), in which case the build skips viewport scoping + collision
 *  (whole-survey, Phase-3 behavior). */
interface ViewportContext {
  viewport: ViewportRel;
  project: (relX: number, relY: number) => readonly [number, number];
}

export interface LabelSyncParams {
  surveyData: SurveyData;
  gpsOrigin: GpsOrigin | null;
  themeColors: MapThemeColors;
  showDepthGradient: boolean;
  depthRange: { min: number; max: number };
  precision?: DecimalPrecision | undefined;
  /** move_comment tool active → comment labels use the FNV-1a palette tint
   *  (`commentColorForKey`), mirroring the stock `commentTextColor()` (#52). */
  commentTint?: boolean | undefined;
}

export interface SurveyLabelControllerOptions {
  /** Defer the fail-safe restore off the render stack (tests inject inline). */
  scheduleRestore?: (fn: () => void) => void;
  /** Coalesce + defer a camera-settle viewport rebuild off the render stack
   *  (tests inject inline to run it synchronously). */
  scheduleRebuild?: (fn: () => void) => void;
  /** Fresh-geometry resync backing the runtime hook (SurveyLayer reads the store).
   *  Absent (unit tests): replay the cached snapshot. */
  resync?: () => void;
  /** Inject a ready atlas (tests / deterministic fake rasterizer), skipping the
   *  async font load so a build is synchronous from the first sync. */
  atlas?: GlyphAtlas;
  /** Font loader (default {@link ensureLabelFont}); tests can stub it. */
  ensureFont?: () => Promise<boolean>;
  /** Rasterizer factory (default {@link createTinySdfRasterizer}). */
  makeRasterizer?: () => GlyphRasterizer | null;
}

export class SurveyLabelController {
  private readonly map: MaplibreMap;
  private readonly layerId: string;
  private layer: SurveyCustomLabelLayer | null = null;
  private active = false;
  /** The glyph atlas — created once the font resolves (or injected in tests). */
  private atlas: GlyphAtlas | null = null;
  private lastData: LabelRenderData | null = null;
  private lastThemeColors: MapThemeColors | null = null;
  /** The most recent sync params, replayed on font-resolve / the runtime hook. */
  private pendingParams: LabelSyncParams | null = null;

  private hookInstalled = false;
  private selfDisableScheduled = false;
  private readonly scheduleRestore: (fn: () => void) => void;
  private readonly scheduleRebuild: (fn: () => void) => void;
  private readonly resync: (() => void) | undefined;

  /** Hysteresis latch for the expensive kinds (§4): true once past LABEL_BUILD_ZOOM,
   *  stays true until below LABEL_DROP_ZOOM. Drives {@link kindsToBuild}. */
  private fullLabelsBuilt = false;
  /** One camera-settle viewport rebuild is queued (coalesces a moveend+zoomend
   *  burst into a single rebuild). */
  private viewportRebuildScheduled = false;
  /** Bound moveend/zoomend handler, kept for `off()` in destroy. */
  private boundCameraSettle: (() => void) | null = null;

  // ── Phase 5 interaction state (mirrors the geometry controller) ──
  /** Anchored / immovable dim set (setDimming); applied to every build + the
   *  cheap flags-only refresh; survives re-enable. */
  private dimState: CustomDimState = EMPTY_DIM;
  /** Drag-exclusion set (setDragHide); dragged features' labels hide. */
  private hideState: CustomRenderExclusion = EMPTY_EXCLUSION;
  /** Cached build products backing the flags-only refresh + collision rerun: the
   *  last descriptor set + its shaped labels / em extents, the last projector +
   *  zoom (collision rerun), and the last collision-loser index set. Rewritten on
   *  every {@link build}. */
  private lastDescriptors: LabelDescriptor[] | null = null;
  private lastShaped: ShapedLabel[] | null = null;
  private lastExtents: (ExtentEm | null)[] | null = null;
  private lastProject: ((relX: number, relY: number) => readonly [number, number]) | null = null;
  private lastZoom: number | undefined = undefined;
  /** Descriptor indices the last collision run hid (COLLIDE_HIDE). */
  private lastCollideHidden: ReadonlySet<number> = new Set();

  /** Per-kind desired visibility (the setShow* toggles + comment-tool override),
   *  indexed by {@link LabelKind}. Held so a re-enable / stock restore reproduces
   *  it; drives `u_kind_visible` while active and each stock layer's restored
   *  visibility while inactive. Defaults mirror the stock layers' initial
   *  `visibility`: section names visible, everything else hidden. */
  private kindVisible: boolean[] = [false, false, true, false, false];
  /** setShowReferenceShots state (false → collapse reference / all-reference). */
  private referenceShotsVisible = true;

  constructor(map: MaplibreMap, layerId = 'survey-custom-labels', opts: SurveyLabelControllerOptions = {}) {
    this.map = map;
    this.layerId = layerId;
    this.scheduleRestore = opts.scheduleRestore ?? defaultScheduleRestore;
    this.scheduleRebuild = opts.scheduleRebuild ?? defaultScheduleRestore;
    this.resync = opts.resync;
    this.installHook();
    // Camera-settle viewport rebuild (§4): re-scope + re-collide once the camera
    // stops. Coalesced, never per frame, never mid-animation. Both events route
    // here (a zoom fires moveend too — coalescing collapses the pair). Guarded
    // for unit-test fakes without an event emitter.
    this.boundCameraSettle = () => this.onCameraSettle();
    this.map.on?.('moveend', this.boundCameraSettle);
    this.map.on?.('zoomend', this.boundCameraSettle);
    if (opts.atlas) {
      this.atlas = opts.atlas;
    } else {
      const ensure = opts.ensureFont ?? ensureLabelFont;
      const makeRast = opts.makeRasterizer ?? createTinySdfRasterizer;
      void ensure().then((ready) => {
        const rasterizer = ready && canRasterize() ? makeRast() : null;
        this.atlas = new GlyphAtlas({ rasterizer });
        // A sync that arrived before the font resolved builds now (design §7).
        if (this.pendingParams) this.sync(this.pendingParams);
      });
    }
  }

  /** True while the custom label layer is drawing (stock text layers hidden).
   *  SurveyLayer reads this to route the setShow* toggles to the custom uniforms
   *  vs the stock layers' visibility. */
  isActive(): boolean {
    return this.active;
  }

  /** Re-evaluate the composed gate and apply / refresh / tear down the label
   *  layer (all five kinds). */
  sync(params: LabelSyncParams): void {
    this.pendingParams = params;
    const enabled = readCustomRenderGate() && readCustomLabelsGate();
    if (!enabled) {
      if (this.active) this.disable();
      return;
    }
    if (!this.atlas) return; // font not resolved yet — build on resolve.
    const data = this.build(params);
    if (!this.active) this.enable(data);
    else {
      this.layer?.update(data);
      this.pushStyle();
    }
  }

  /** Mirror the five setShow* toggles: drive the kind's uniform when active
   *  (stock stays suppressed); store the desired state either way so a later
   *  enable / stock restore reproduces it. */
  setShotLabelsVisible(visible: boolean): void {
    this.setKindVisible(LABEL_KIND.SHOT_LABEL, visible);
  }
  setStationLabelsVisible(visible: boolean): void {
    this.setKindVisible(LABEL_KIND.STATION_LABEL, visible);
  }
  setSectionNamesVisible(visible: boolean): void {
    this.setKindVisible(LABEL_KIND.SECTION_NAME, visible);
  }
  setStationCommentsVisible(visible: boolean): void {
    this.setKindVisible(LABEL_KIND.STATION_COMMENT, visible);
  }
  setShotCommentsVisible(visible: boolean): void {
    this.setKindVisible(LABEL_KIND.SHOT_COMMENT, visible);
  }

  private setKindVisible(kind: LabelKind, visible: boolean): void {
    this.kindVisible[kind] = visible;
    // The toggle itself is a pure uniform flip (the shader shows/hides the kind
    // with no rebuild). It also changes the collision CANDIDATE set, so re-run
    // collision + refresh the flags (Phase 5) — cheap now that updateFlags exists
    // — so a toggled-off kind stops occupying declutter space and a toggled-on
    // kind is decluttered against immediately. rerunCollision no-ops without a
    // projector (unit-test fakes / below-gate), leaving the pure-uniform flip.
    if (this.active) {
      this.pushStyle();
      this.rerunCollision();
    }
  }

  /** Mirror setShowReferenceShots (label half): flip the shader uniform, then
   *  re-declutter (reference-hide changes the collision candidate set). */
  setReferenceShotsVisible(visible: boolean): void {
    this.referenceShotsVisible = visible;
    if (this.active) {
      this.pushStyle();
      this.rerunCollision();
    }
  }

  /** Build the current NON-zoom style inputs (DPR, per-kind toggle, halo colors,
   *  reference-hide) the layer folds with live zoom each frame. */
  private computeStyle(): LabelStyleInputs {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const haloColors = this.lastThemeColors ? resolveHaloColors(this.lastThemeColors) : [];
    return { dpr, kindEnabled: this.kindVisible.slice(), haloColors, hideReference: !this.referenceShotsVisible };
  }

  private pushStyle(): void {
    this.layer?.setStyleInputs(this.computeStyle());
    if (this.active) this.map.triggerRepaint();
  }

  /**
   * Build the GPU-ready label buffers from SoA, VIEWPORT-SCOPED with COLLISION
   * baked in (§4/§5). Below the expensive-kinds zoom band only section names
   * build; below their minzoom nothing does. In a unit-test fake with no
   * `getZoom` the zoom gate + viewport + collision are all skipped (whole-survey,
   * all kinds — the Phase-3 behavior those tests lock).
   */
  private build(params: LabelSyncParams): LabelRenderData {
    const t0 = performance.now();
    const { surveyData, gpsOrigin } = params;
    this.lastThemeColors = params.themeColors;
    const [anchorX, anchorY] = computeMercatorAnchor(surveyData, gpsOrigin);
    const colorCtx = labelColorContextFrom(params.showDepthGradient, params.depthRange, params.themeColors);
    // Comment palette tint (#52): only while move_comment is active; else comments
    // use the flat labelColor (the tessellator's fallback). Same key + palette as
    // colorResolvers.ts / features.ts, so the label tint matches the geometry tint.
    const commentColor = params.commentTint
      ? (ownerKey: string): Rgba8 => packCssColor(commentColorForKey(ownerKey))
      : undefined;

    const zoom = this.map.getZoom?.();
    const hasData = surveyData.stationCount > 0;
    const kinds = zoom === undefined ? undefined : this.kindsToBuild(zoom, hasData);
    const vpCtx = zoom === undefined ? null : this.computeViewportContext(anchorX, anchorY);

    const descriptors = buildLabelDescriptors(
      surveyData, gpsOrigin, anchorX, anchorY,
      { colorCtx, precision: params.precision, commentColor },
      kinds, vpCtx?.viewport,
    );
    const shaped = shapeDescriptors(descriptors, this.atlas!);
    const extents = shaped.map(shapedExtent);

    // Collision (§5). Only runs when the map can project (a fake without
    // bounds/canvas keeps every label, no collision). The loser set is retained
    // (not baked into desc.flags) so a later flags-only refresh — dim / drag /
    // collision rerun — can recombine it with the current DIM / DRAG bits.
    let collideHidden: ReadonlySet<number> = new Set();
    if (vpCtx !== null && zoom !== undefined) {
      collideHidden = new Set(collideLabels(descriptors, extents, {
        zoom,
        project: vpCtx.project,
        kindVisible: this.kindVisible,
        hideReference: !this.referenceShotsVisible,
      }));
    }

    // Retain the build products for the cheap flag paths + collision rerun.
    this.lastDescriptors = descriptors;
    this.lastShaped = shaped;
    this.lastExtents = extents;
    this.lastProject = vpCtx?.project ?? null;
    this.lastZoom = zoom;
    this.lastCollideHidden = collideHidden;

    const buffers = buildLabelBuffersFromShaped(descriptors, shaped, (i) =>
      this.labelFlagByte(descriptors[i]!, collideHidden.has(i)),
    );
    debugLog('[customRender] label build', {
      ms: +(performance.now() - t0).toFixed(1),
      zoom: zoom === undefined ? null : +zoom.toFixed(2),
      labels: descriptors.length,
      hidden: collideHidden.size,
      glyphs: buffers.glyphCount,
      mb: +(buffers.byteLength / 1048576).toFixed(2),
    });
    this.lastData = { anchorX, anchorY, buffers, atlas: this.atlas! };
    return this.lastData;
  }

  /**
   * The full per-label flag byte = STATIC bits (FIRST_IN_SECTION / REFERENCE /
   * ALL_REFERENCE, from the descriptor) OR the dynamic interaction bits:
   * COLLIDE_HIDE (this label lost collision), DIM (anchored / immovable), and
   * DRAG_HIDE (a move tool is dragging its feature). One place both the build
   * emit and the flags-only refresh compute the byte, so they never diverge.
   */
  private labelFlagByte(desc: LabelDescriptor, collideHidden: boolean): number {
    let f = desc.flags;
    if (collideHidden) f |= LABEL_FLAG.COLLIDE_HIDE;
    if (this.dimBitFor(desc)) f |= LABEL_FLAG.DIM;
    if (this.dragBitFor(desc)) f |= LABEL_FLAG.DRAG_HIDE;
    return f;
  }

  /**
   * Whether a label dims (0.25), keyed on the SAME state the stock label paint
   * expressions use (updateLabelAnchoredOpacity / updateImmovableLabelOpacity):
   *  - shot label:    anchored(section) OR immovable-shot(section·STRIDE+shotId)
   *  - station label: anchored(section) OR immovable-station(section·STRIDE+idx)
   *  - section name:  anchored(section) only (never immovable-dimmed)
   *  - comments:      never (stock never dims comment layers).
   */
  private dimBitFor(desc: LabelDescriptor): boolean {
    const { anchoredSectionIds, immovableStationFeatureIds, immovableShotFeatureIds } = this.dimState;
    const sid = desc.sectionId;
    if (sid === undefined) return false;
    const anchored = anchoredSectionIds.has(sid);
    switch (desc.kind) {
      case LABEL_KIND.SHOT_LABEL:
        return (
          anchored ||
          (immovableShotFeatureIds.size > 0 &&
            desc.shotId !== undefined &&
            immovableShotFeatureIds.has(sid * FEATURE_ID_STRIDE + desc.shotId))
        );
      case LABEL_KIND.STATION_LABEL:
        return (
          anchored ||
          (immovableStationFeatureIds.size > 0 &&
            desc.stationIndex !== undefined &&
            immovableStationFeatureIds.has(sid * FEATURE_ID_STRIDE + desc.stationIndex))
        );
      case LABEL_KIND.SECTION_NAME:
        return anchored;
      default:
        return false; // comments: stock leaves them at full opacity
    }
  }

  /**
   * Whether a label is drag-hidden, keyed on the SAME drag exclusion the geometry
   * controller + the stock drag filters use (excludedStationGlobals /
   * excludedShotGlobals / whole-section drag): station-owned labels + comments
   * follow the station set, shot-owned follow the shot set, and either follows a
   * whole-section exclusion. Section names are NOT drag-hidden (stock leaves
   * `survey-labels` out of the drag hide-layers).
   */
  private dragBitFor(desc: LabelDescriptor): boolean {
    const { sectionIds, stationGlobalIndices, shotGlobalIndices } = this.hideState;
    const sid = desc.sectionId;
    if (sid === undefined) return false;
    if (sectionIds?.has(sid) === true) {
      return desc.kind !== LABEL_KIND.SECTION_NAME;
    }
    switch (desc.kind) {
      case LABEL_KIND.STATION_LABEL:
      case LABEL_KIND.STATION_COMMENT:
        return desc.stationGlobal !== undefined && stationGlobalIndices?.has(desc.stationGlobal) === true;
      case LABEL_KIND.SHOT_LABEL:
      case LABEL_KIND.SHOT_COMMENT:
        return desc.shotGlobal !== undefined && shotGlobalIndices?.has(desc.shotGlobal) === true;
      default:
        return false; // section names never drag-hide
    }
  }

  /**
   * Re-stamp ONLY the per-vertex flags buffer from the retained build products +
   * the current dim / drag / collision state, and re-upload it (no reshape /
   * reproject / recolor). The cheap path behind setDimming / setDragHide /
   * collision rerun. No-op until a build has run (state is still stored, so the
   * next build reproduces it).
   */
  private refreshFlags(): void {
    if (!this.active || !this.layer || !this.lastDescriptors || !this.lastShaped) return;
    const descriptors = this.lastDescriptors;
    const collideHidden = this.lastCollideHidden;
    const flags = buildLabelFlags(this.lastShaped, (i) =>
      this.labelFlagByte(descriptors[i]!, collideHidden.has(i)),
    );
    this.layer.updateFlags(flags);
    this.map.triggerRepaint?.();
  }

  /**
   * Re-run collision over the retained viewport set with the CURRENT candidate
   * inputs (kind toggles, reference-hide) and refresh the flags. Cheap (the set
   * is viewport-bounded) and used when a toggle changes the candidate set so the
   * declutter updates immediately rather than at the next build (Phase 4's
   * deferred approximation, now cheap that updateFlags exists). No-op without a
   * projector (unit-test fakes / below-gate builds) — the toggle stays a pure
   * uniform flip there.
   */
  private rerunCollision(): void {
    if (!this.active || !this.lastDescriptors || !this.lastExtents || this.lastProject === null || this.lastZoom === undefined) {
      return;
    }
    this.lastCollideHidden = new Set(collideLabels(this.lastDescriptors, this.lastExtents, {
      zoom: this.lastZoom,
      project: this.lastProject,
      kindVisible: this.kindVisible,
      hideReference: !this.referenceShotsVisible,
    }));
    this.refreshFlags();
  }

  /**
   * Update the anchored / immovable dim set (SurveyLayer.syncCustomDimming). Cheap
   * flags-only refresh; state stored regardless so the next build reproduces it.
   * Mirrors the geometry controller's {@link CustomDimState} setDimming.
   */
  setDimming(state: CustomDimState): void {
    this.dimState = state;
    if (this.active) this.refreshFlags();
  }

  /**
   * Point the label layer at (or off, with null) the active drag's hidden feature
   * set (SurveyLayer.setDragExclusion). Cheap flags-only refresh; state stored so
   * a mid-drag build / re-enable reproduces it. The dragged features' labels
   * collapse via DRAG_HIDE — the synchronous GPU flag that makes the stock
   * LabelRestoreController deferral unnecessary under the gate (§8).
   */
  setDragHide(exclusion: CustomRenderExclusion | null): void {
    this.hideState = exclusion ?? EMPTY_EXCLUSION;
    if (this.active) this.refreshFlags();
  }

  /**
   * Which kinds to build at `zoom` (§4). The expensive kinds (shot/station
   * labels + comments) follow the 13.5/13 hysteresis; section names follow their
   * own minzoom (10) so they still show at z10..13.5. Returns `undefined` (=
   * every kind) once past the band, a section-only set in [10, band), or an
   * empty set below 10. Also latches {@link fullLabelsBuilt} for the hysteresis.
   */
  private kindsToBuild(zoom: number, hasData: boolean): ReadonlySet<LabelKind> | undefined {
    const wantFull = this.fullLabelsBuilt ? zoom >= LABEL_DROP_ZOOM : zoom >= LABEL_BUILD_ZOOM;
    this.fullLabelsBuilt = wantFull && hasData;
    if (wantFull) return undefined;
    if (zoom >= SECTION_NAME_MIN_ZOOM) return SECTION_ONLY_KINDS;
    return NO_KINDS;
  }

  /**
   * The padded viewport rect (anchor-relative mercator) + a mercator→CSS-px
   * projector, both from one `map.getBounds()`. Rotation + pitch are disabled
   * app-wide (north-up, 0° pitch), so mercator→screen is an exact axis-aligned
   * affine — no per-label `map.project`. `null` when the map cannot supply
   * bounds / a canvas (unit-test fakes → no viewport scoping, no collision).
   */
  private computeViewportContext(anchorX: number, anchorY: number): ViewportContext | null {
    const bounds = this.map.getBounds?.();
    const canvas = this.map.getCanvas?.();
    if (!bounds || !canvas) return null;
    const [minX] = lngLatToMercator(bounds.getWest(), bounds.getNorth()); // x ← lng
    const [maxX] = lngLatToMercator(bounds.getEast(), bounds.getNorth());
    const [, minY] = lngLatToMercator(bounds.getWest(), bounds.getNorth()); // y ← lat; north → min
    const [, maxY] = lngLatToMercator(bounds.getWest(), bounds.getSouth()); // south → max
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    if (!(spanX > 0) || !(spanY > 0) || !(width > 0) || !(height > 0)) return null;
    const padX = spanX * VIEWPORT_PADDING;
    const padY = spanY * VIEWPORT_PADDING;
    const viewport: ViewportRel = {
      minX: minX - padX - anchorX,
      maxX: maxX + padX - anchorX,
      minY: minY - padY - anchorY,
      maxY: maxY + padY - anchorY,
    };
    const sx = width / spanX;
    const sy = height / spanY;
    const project = (relX: number, relY: number): readonly [number, number] => [
      (relX + anchorX - minX) * sx,
      (relY + anchorY - minY) * sy,
    ];
    return { viewport, project };
  }

  /**
   * A camera gesture ended (moveend/zoomend). Coalesce a burst into ONE deferred
   * viewport rebuild (never per frame, §4); the deferred callback skips if the
   * camera is still animating (a chained ease) and waits for the next settle.
   */
  private onCameraSettle(): void {
    if (!this.active || this.viewportRebuildScheduled) return;
    this.viewportRebuildScheduled = true;
    this.scheduleRebuild(() => {
      this.viewportRebuildScheduled = false;
      if (!this.active) return;
      if (this.map.isMoving?.()) return; // still animating — the next settle rebuilds
      this.rebuildViewport();
    });
  }

  /** Re-scope + re-collide from the last sync params (geometry unchanged on a
   *  camera move, so replaying them is correct and cheap) and swap the buffer. */
  private rebuildViewport(): void {
    if (!this.active || !this.atlas || !this.pendingParams) return;
    const data = this.build(this.pendingParams);
    this.layer?.update(data);
    this.map.triggerRepaint?.();
  }

  private enable(data: LabelRenderData): void {
    if (!this.map.getStyle) return;
    const layer = new SurveyCustomLabelLayer(this.layerId, data, (reason) => this.handleSelfDisable(reason));
    layer.setStyleInputs(this.computeStyle());
    // No beforeId: the label layer draws on top (labels above geometry + overlays).
    this.map.addLayer(layer);
    if (layer.isDisabled()) {
      // FAIL-SAFE: never hide the stock station labels behind a layer that can't
      // draw. Remove the dead layer and restore the stock label visibility.
      const reason = layer.getDisabledReason() ?? 'unknown';
      console.warn(
        `[customRender] custom label layer failed to initialize (${reason}); ` +
          'keeping stock label layers visible',
      );
      if (this.map.getLayer?.(this.layerId)) this.map.removeLayer(this.layerId);
      this.setStockLabelVisibility('restore');
      this.layer = null;
      this.active = false;
      return;
    }
    this.layer = layer;
    this.setStockLabelVisibility('suppress');
    this.active = true;
    console.info('[customRender] label layer enabled; stock label layers hidden', {
      glyphs: data.buffers.glyphCount,
    });
    this.map.triggerRepaint();
  }

  private disable(): void {
    this.teardown();
    console.info('[customRender] label layer disabled; stock label layers restored');
  }

  /** Remove the custom label layer + restore the stock station-label visibility
   *  to its desired toggle state. Safe when already inactive. */
  private teardown(): void {
    if (this.map.getLayer?.(this.layerId)) this.map.removeLayer(this.layerId);
    this.layer = null;
    this.setStockLabelVisibility('restore');
    this.active = false;
    this.map.triggerRepaint();
  }

  /**
   * The custom label layer hit a GL error mid-render and disabled itself. Fires
   * INSIDE MapLibre's frame, so defer the stock-label restore off the render
   * stack. Idempotent + re-entrancy-safe (mirrors the geometry controller).
   */
  private handleSelfDisable(reason: string): void {
    if (!this.active || this.selfDisableScheduled) return;
    this.selfDisableScheduled = true;
    console.warn(
      `[customRender] custom label layer self-disabled (${reason}); restoring stock label layers`,
    );
    this.scheduleRestore(() => {
      this.selfDisableScheduled = false;
      if (this.active) this.teardown();
    });
  }

  /** `suppress` → hide all five stock text layers; `restore` → set each back to
   *  its kind's DESIRED toggle state (not blindly 'visible', unlike geometry —
   *  labels have meaningful per-kind user toggles). */
  private setStockLabelVisibility(mode: 'suppress' | 'restore'): void {
    for (let k = 0; k < LABEL_KIND_COUNT; k++) {
      const id = STOCK_LABEL_LAYER_BY_KIND[k as LabelKind];
      const v = mode === 'suppress' ? 'none' : this.kindVisible[k] ? 'visible' : 'none';
      if (this.map.getLayer?.(id)) {
        try {
          this.map.setLayoutProperty(id, 'visibility', v);
        } catch {
          // Layer may be mid-teardown; ignore.
        }
      }
    }
  }

  private installHook(): void {
    if (this.hookInstalled || typeof window === 'undefined') return;
    (window as unknown as Record<string, unknown>)[CUSTOM_LABELS_SYNC_HOOK] = () => this.runSyncHook();
    this.hookInstalled = true;
  }

  private runSyncHook(): void {
    if (this.resync) this.resync();
    else if (this.pendingParams) this.sync(this.pendingParams);
  }

  destroy(): void {
    if (this.active) this.disable();
    if (this.boundCameraSettle) {
      this.map.off?.('moveend', this.boundCameraSettle);
      this.map.off?.('zoomend', this.boundCameraSettle);
      this.boundCameraSettle = null;
    }
    if (this.hookInstalled && typeof window !== 'undefined') {
      delete (window as unknown as Record<string, unknown>)[CUSTOM_LABELS_SYNC_HOOK];
      this.hookInstalled = false;
    }
    this.pendingParams = null;
  }
}
