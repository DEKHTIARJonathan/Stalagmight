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
 * FONT READINESS: the SDF atlas needs the bundled font loaded (async). If a sync
 * arrives before the font resolves, it is remembered and built once the font is
 * ready (then `triggerRepaint`); every later sync is synchronous.
 */
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { GpsOrigin, DecimalPrecision } from '../../../../types/config';
import type { SurveyData } from '../../../../types/survey-data';
import type { MapThemeColors } from '../../../../utils/themeColors';
import { debugLog } from '../../../../utils/debugLog';
import { commentColorForKey } from '../features';
import { computeMercatorAnchor } from './mercator';
import { buildLabelDescriptors, buildLabelBuffers } from './labelTessellate';
import { labelColorContextFrom } from './labelText';
import { LABEL_KIND, LABEL_KIND_COUNT, type LabelKind } from './labelShaders';
import { packCssColor, type Rgba8 } from './colorPack';
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

/** Same off-the-render-stack deferral as the geometry controller. */
function defaultScheduleRestore(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else if (typeof queueMicrotask === 'function') queueMicrotask(fn);
  else setTimeout(fn, 0);
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
  private readonly resync: (() => void) | undefined;

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
    this.resync = opts.resync;
    this.installHook();
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
    if (this.active) this.pushStyle();
  }

  /** Mirror setShowReferenceShots (label half): flip the shader uniform. */
  setReferenceShotsVisible(visible: boolean): void {
    this.referenceShotsVisible = visible;
    if (this.active) this.pushStyle();
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

  /** Build the GPU-ready label buffers from SoA (all five kinds). */
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
    const descriptors = buildLabelDescriptors(
      surveyData, gpsOrigin, anchorX, anchorY, { colorCtx, precision: params.precision, commentColor },
    );
    const buffers = buildLabelBuffers(descriptors, this.atlas!);
    debugLog('[customRender] label build', {
      ms: +(performance.now() - t0).toFixed(1),
      labels: descriptors.length,
      glyphs: buffers.glyphCount,
      mb: +(buffers.byteLength / 1048576).toFixed(2),
    });
    this.lastData = { anchorX, anchorY, buffers, atlas: this.atlas! };
    return this.lastData;
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
    if (this.hookInstalled && typeof window !== 'undefined') {
      delete (window as unknown as Record<string, unknown>)[CUSTOM_LABELS_SYNC_HOOK];
      this.hookInstalled = false;
    }
    this.pendingParams = null;
  }
}
