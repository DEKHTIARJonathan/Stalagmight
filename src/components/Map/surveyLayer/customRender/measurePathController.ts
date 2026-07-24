// Measure-path controller (#26, stage 2a of #customRender stock deletion). Owns
// the dedicated {@link SurveyMeasurePathLayer} that draws the ruler's measured
// along-cave-line tint (measured shots as round-cap lines, measured stations as
// filled discs, one tint via a uniform) directly from typed-array buffers — no
// stock `survey-measure-path` layer, no `-shots`/`-stations` vector-tile source,
// no `measured` feature-state.
//
// Stage 2a runs this ALONGSIDE the stock feature-state path (both draw the same
// MEASURE_TINT at the same z-slot, so the pixels are identical); stage 2b then
// deletes the stock path and this becomes the sole measure-path renderer.
//
// SurveyLayer builds the render data (decoding the measured id sets to coords via
// its geometry index) and calls `setPath(...)` / `clear()`; this controller only
// owns the layer lifecycle: add at the right z-order, re-upload on change, remove
// on clear, and self-heal a GL failure by dropping the dead layer (the stock tint
// still covers it in stage 2a).

import type maplibregl from 'maplibre-gl';
import { SurveyMeasurePathLayer, type MeasurePathRenderData } from './surveyMeasurePathLayer';

/** The surface the controller uses from its GL layer (real or a test fake). */
export interface MeasurePathLayerLike {
  readonly id: string;
  isDisabled(): boolean;
  getDisabledReason(): string | null;
  setData(data: MeasurePathRenderData): void;
}

/** Injectable seams (defaults are the real layer + rAF). Tests override both. */
export interface MeasurePathDeps {
  /** Build the GL layer. Defaults to a real {@link SurveyMeasurePathLayer}. */
  makeLayer?: (
    id: string,
    data: MeasurePathRenderData | null,
    onSelfDisable: (reason: string) => void,
  ) => MeasurePathLayerLike;
  /** Defer a style mutation off MapLibre's render stack (self-disable removal). */
  scheduleRestore?: (fn: () => void) => void;
}

function defaultScheduleRestore(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else if (typeof queueMicrotask === 'function') queueMicrotask(fn);
  else setTimeout(fn, 0);
}

export class MeasurePathController {
  private layer: MeasurePathLayerLike | null = null;
  private readonly makeLayer: NonNullable<MeasurePathDeps['makeLayer']>;
  private readonly scheduleRestore: (fn: () => void) => void;
  /** Bumped on every clear/destroy so a deferred self-disable removal that a
   *  newer path superseded is a no-op (mirrors the ghost controller's guard). */
  private generation = 0;
  private selfDisableScheduled = false;

  constructor(
    private readonly map: maplibregl.Map,
    deps: MeasurePathDeps = {},
    private readonly layerId = 'survey-measure-path-custom',
  ) {
    this.makeLayer =
      deps.makeLayer ??
      ((id, data, onSelfDisable) => new SurveyMeasurePathLayer(id, data, onSelfDisable));
    this.scheduleRestore = deps.scheduleRestore ?? defaultScheduleRestore;
  }

  /** True while the custom measure-path layer is added and drawing (test/host). */
  isActive(): boolean {
    return this.layer !== null;
  }

  /**
   * Show / update the measured path. Pass render data with content to draw it;
   * pass null (or data whose line + circle are both empty) to clear.
   *
   * `beforeIdCandidates` are tried in order; the layer is inserted before the
   * first one that exists so it lands directly beneath the hover/selection
   * overlay (and beneath the stock tint in stage 2a) — see SurveyLayer. If none
   * exist the layer draws on top.
   */
  setPath(data: MeasurePathRenderData | null, beforeIdCandidates: readonly string[] = []): void {
    const empty = !data || (data.line.segmentCount === 0 && data.circle.pointCount === 0);
    if (empty) {
      this.clear();
      return;
    }
    if (this.layer) {
      this.layer.setData(data);
      this.map.triggerRepaint();
      return;
    }
    this.add(data, beforeIdCandidates);
  }

  /** Remove the custom measure-path layer (idempotent). */
  clear(): void {
    this.generation++;
    this.selfDisableScheduled = false;
    if (this.layer && this.map.getLayer?.(this.layerId)) this.map.removeLayer(this.layerId);
    this.layer = null;
  }

  /** Tear down on SurveyLayer destroy. */
  destroy(): void {
    this.clear();
  }

  /** Create + add the layer at the resolved z-order. Drops it (leaving the stage
   *  2a stock tint to cover) if WebGL2 is unavailable / shaders fail / it throws. */
  private add(data: MeasurePathRenderData, beforeIdCandidates: readonly string[]): void {
    try {
      const layer = this.makeLayer(this.layerId, data, (reason) => this.handleSelfDisable(reason));
      const beforeId = this.resolveBeforeId(beforeIdCandidates);
      this.map.addLayer(layer as unknown as maplibregl.CustomLayerInterface, beforeId);
      if (layer.isDisabled()) {
        if (this.map.getLayer?.(this.layerId)) this.map.removeLayer(this.layerId);
        console.warn(
          `[measurePath] custom measure-path failed to initialize (${layer.getDisabledReason() ?? 'unknown'}); ` +
            'stock tint remains',
        );
        return;
      }
      this.layer = layer;
      this.map.triggerRepaint();
    } catch (e) {
      console.warn('[measurePath] custom measure-path threw on add; stock tint remains', e);
      if (this.map.getLayer?.(this.layerId)) this.map.removeLayer(this.layerId);
      this.layer = null;
    }
  }

  private resolveBeforeId(candidates: readonly string[]): string | undefined {
    for (const id of candidates) {
      if (this.map.getLayer?.(id)) return id;
    }
    return undefined;
  }

  /**
   * The layer hit a GL error mid-render and disabled itself (fired INSIDE
   * MapLibre's render pass, so a style mutation now is unsafe). Defer dropping
   * the dead layer; in stage 2a the stock `survey-measure-path` still draws the
   * tint, so the user never loses it. Idempotent + generation-guarded.
   */
  private handleSelfDisable(reason: string): void {
    if (!this.layer || this.selfDisableScheduled) return;
    this.selfDisableScheduled = true;
    const gen = this.generation;
    console.warn(`[measurePath] custom measure-path self-disabled (${reason}); stock tint remains`);
    this.scheduleRestore(() => {
      if (gen !== this.generation) return; // superseded by a clear / new path
      this.selfDisableScheduled = false;
      if (this.map.getLayer?.(this.layerId)) this.map.removeLayer(this.layerId);
      this.layer = null;
    });
  }
}
