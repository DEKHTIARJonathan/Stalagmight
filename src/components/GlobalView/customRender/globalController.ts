/**
 * Controller wiring the custom WebGL render into GlobalSurveyLayer
 * (#customRender). Sibling of `Map/surveyLayer/customRender/controller.ts`,
 * keeping GlobalSurveyLayer to a few integration lines: it constructs one of
 * these, calls `sync(systems)` after each geometry flush, routes its
 * hover/select/search/reference/visibility/theme setters here, and asks `pick()`
 * to resolve interaction hits (replacing queryRenderedFeatures).
 *
 * Flag ON  : add the custom layer below the stock global-survey layers, hide the
 *            stock shots/stations (+ hitbox) layers, and drive everything from
 *            typed-array buffers + the geometry hit index.
 * Flag OFF : remove the custom layer, restore the stock layers' visibility.
 *
 * The gate is the SAME `stalagmight_custom_render` flag the single-system view
 * reads. A fail-safe (self-disable on a GL error) defers a stock-layer restore
 * off MapLibre's render stack, so the survey never ends up blank.
 */
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { ProjectMetadata } from '../../../types/project';
import type { SystemGeometry } from '../systemColor';
import { readCustomRenderGate } from '../../Map/surveyLayer/customRender/gate';
import { packCssColor } from '../../Map/surveyLayer/customRender/colorPack';
import {
  buildGlobalBuffers,
  recomputeDimFlags,
  recomputeSelectedFlags,
  type GlobalBuildResult,
} from './globalTessellate';
import {
  GlobalCustomLayer,
  type GlobalCustomRenderData,
  type Rgba01,
} from './globalCustomLayer';
import { GlobalHitIndex, type GlobalHit, type ProjectFn } from './globalHitIndex';

/** Stock global-survey layers hidden while the custom layer is on. */
const HIDDEN_STOCK_LAYERS = [
  'global-survey-shots-layer',
  'global-survey-stations-layer',
  'global-survey-shots-hitbox',
  'global-survey-stations-hitbox',
] as const;

/** Stock base visual weights (CSS px) the custom layer mirrors. */
const BASE_SHOT_WIDTH = 2;
const BASE_STATION_RADIUS = 4;
const BASE_STATION_STROKE = 1;

/** Stock hitbox reaches: station circle-radius 10, shot line-width 10 -> 5. */
const STATION_REACH = 10;
const SHOT_REACH = 5;

/** Defer a fail-safe restore off MapLibre's render stack (rAF preferred; test
 *  fallbacks for non-DOM envs). Injectable for deterministic tests. */
function defaultScheduleRestore(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else if (typeof queueMicrotask === 'function') queueMicrotask(fn);
  else setTimeout(fn, 0);
}

export interface GlobalCustomControllerOptions {
  /** Override how the fail-safe restore is deferred. Defaults to rAF. */
  scheduleRestore?: (fn: () => void) => void;
  /**
   * Notified whenever the custom layer's active (drawing) state flips. `true`
   * once added AND drawing (stock layers hidden); `false` on teardown, gate-off,
   * or a fail-safe self-disable. GlobalSurveyLayer uses this to stop / resume the
   * stock vector-tile publish in lockstep (mirrors the single-system view).
   */
  onActiveChange?: (active: boolean) => void;
}

function packStroke(css: string): Rgba01 {
  const [r, g, b, a] = packCssColor(css);
  return [r / 255, g / 255, b / 255, a / 255];
}

export class GlobalCustomController {
  private readonly map: MaplibreMap;
  private readonly layerId: string;
  private readonly scheduleRestore: (fn: () => void) => void;
  private readonly onActiveChange: ((active: boolean) => void) | undefined;

  private layer: GlobalCustomLayer | null = null;
  private active = false;
  private selfDisableScheduled = false;

  // Current systems + derived state, held so a (re)enable rebuilds correctly.
  private systems: SystemGeometry[] = [];
  private metadataById = new Map<string, ProjectMetadata>();
  private hitIndex: GlobalHitIndex | null = null;
  private build: GlobalBuildResult | null = null;
  private data: GlobalCustomRenderData | null = null;

  private searchTerm: string | null = null;
  private selectedIds: ReadonlySet<string> = new Set();
  private referenceVisible = true;
  private visible = true;
  private strokeColor: Rgba01 = [1, 1, 1, 1];

  constructor(map: MaplibreMap, layerId = 'global-survey-custom', opts: GlobalCustomControllerOptions = {}) {
    this.map = map;
    this.layerId = layerId;
    this.scheduleRestore = opts.scheduleRestore ?? defaultScheduleRestore;
    this.onActiveChange = opts.onActiveChange;
  }

  /** Whether the custom layer is drawing (stock layers hidden). */
  isActive(): boolean {
    return this.active;
  }

  /** Metadata for a system id (tooltip lookup for the resolved hit). */
  getSystemMetadata(systemId: string): ProjectMetadata | undefined {
    return this.metadataById.get(systemId);
  }

  /** Re-evaluate the gate and apply/refresh or tear down the custom layer. */
  sync(systems: SystemGeometry[]): void {
    this.systems = systems;
    this.metadataById = new Map(systems.map((s) => [s.metadata.file_path, s.metadata]));
    this.hitIndex = new GlobalHitIndex(systems);

    const enabled = readCustomRenderGate();
    if (!enabled) {
      if (this.active) this.disable();
      return;
    }
    const data = this.buildData();
    if (!this.active) this.enable(data);
    else this.layer?.update(data);
  }

  private buildData(): GlobalCustomRenderData {
    const build = buildGlobalBuffers(this.systems, {
      searchTerm: this.searchTerm,
      selectedIds: this.selectedIds,
    });
    this.build = build;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const data: GlobalCustomRenderData = {
      anchorX: build.anchorX,
      anchorY: build.anchorY,
      line: build.line,
      circle: build.circle,
      lineHalfWidthPx: (BASE_SHOT_WIDTH / 2) * dpr,
      circleRadiusPx: BASE_STATION_RADIUS * dpr,
      circleStrokePx: BASE_STATION_STROKE * dpr,
      aaPx: dpr,
      strokeColor: this.strokeColor,
    };
    this.data = data;
    return data;
  }

  private enable(data: GlobalCustomRenderData): void {
    if (!this.map.getStyle) return;
    const layer = new GlobalCustomLayer(this.layerId, data, (reason) => this.handleSelfDisable(reason));
    layer.setVisible(this.visible);
    layer.setReferenceShotsVisible(this.referenceVisible);
    layer.setHoverSystem(-1);
    // Draw below the stock shots layer (above the basemap) if present.
    const beforeId = this.map.getLayer('global-survey-shots-layer')
      ? 'global-survey-shots-layer'
      : undefined;
    this.map.addLayer(layer, beforeId);
    if (layer.isDisabled()) {
      const reason = layer.getDisabledReason() ?? 'unknown';
      console.warn(
        `[globalCustomRender] custom layer failed to initialize (${reason}); ` +
          'keeping stock global-survey layers visible',
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
    console.info('[globalCustomRender] enabled; stock global-survey layers hidden', {
      systems: this.systems.length,
      shotSegments: data.line.segmentCount,
      stations: data.circle.stationCount,
    });
    this.map.triggerRepaint();
  }

  private disable(): void {
    this.teardown();
    console.info('[globalCustomRender] disabled; stock global-survey layers restored');
  }

  /** Remove the custom layer + restore the stock layers. `fireRepublish` true
   *  (gate-off / self-disable) drives the stock vector-tile republish through
   *  {@link setActive}; false (destroy) sets `active` directly so onActiveChange
   *  never fires — GlobalSurveyLayer is about to clear the registry + remove the
   *  map, so that republish would be wasted work (and can freeze dense
   *  multi-system views on exit). */
  private teardown(fireRepublish = true): void {
    if (this.map.getLayer?.(this.layerId)) this.map.removeLayer(this.layerId);
    this.layer = null;
    this.setStockVisibility('visible');
    if (fireRepublish) this.setActive(false);
    else this.active = false;
    this.map.triggerRepaint();
  }

  private handleSelfDisable(reason: string): void {
    if (!this.active || this.selfDisableScheduled) return;
    this.selfDisableScheduled = true;
    console.warn(
      `[globalCustomRender] custom layer self-disabled (${reason}); restoring stock layers`,
    );
    this.scheduleRestore(() => {
      this.selfDisableScheduled = false;
      if (this.active) this.teardown();
    });
  }

  private setActive(v: boolean): void {
    if (this.active === v) return;
    this.active = v;
    this.onActiveChange?.(v);
  }

  /** Suppress (`'none'`) hides every stock survey + hitbox layer unconditionally.
   *  Restore (`'visible'`) honors the stored markers-only toggle instead of
   *  blindly showing: in markers-only mode (`setVisible(false)`) the survey
   *  geometry + hitboxes must stay hidden after a fallback, matching `pick()`
   *  which returns no hits while `!visible`; otherwise hidden geometry reappears
   *  over the markers view and becomes interactive again. Mirrors the survey
   *  controller's restore direction. */
  private setStockVisibility(v: 'none' | 'visible'): void {
    for (const id of HIDDEN_STOCK_LAYERS) {
      if (!this.map.getLayer?.(id)) continue;
      const visibility = v === 'none' ? 'none' : this.visible ? 'visible' : 'none';
      try {
        this.map.setLayoutProperty(id, 'visibility', visibility);
      } catch {
        // Layer may be mid-teardown; ignore.
      }
    }
  }

  /** Hovered system (or null). Uniform-only refresh, no buffer re-upload. */
  setHover(systemId: string | null): void {
    const idx = systemId !== null ? this.build?.systemIndex.get(systemId) ?? -1 : -1;
    this.layer?.setHoverSystem(idx);
    if (this.active) this.map.triggerRepaint();
  }

  /** Selected systems. Recomputes the per-vertex selected flags + re-uploads. */
  setSelected(selectedIds: ReadonlySet<string>): void {
    this.selectedIds = new Set(selectedIds);
    if (!this.active || !this.layer || !this.build || !this.data) return;
    const { systemIndex } = this.build;
    const indexToId = new Map<number, string>();
    for (const [id, i] of systemIndex) indexToId.set(i, id);
    const selForIndex = (i: number): boolean => {
      const id = indexToId.get(i);
      return id !== undefined && this.selectedIds.has(id);
    };
    recomputeSelectedFlags(this.data.line, this.data.circle, selForIndex);
    this.layer.updateSelected(this.data.line.selected, this.data.circle.selected);
    this.map.triggerRepaint();
  }

  /** Search term (dims non-matching systems). Recomputes dim flags + re-uploads. */
  setSearch(term: string | null): void {
    this.searchTerm = term ? term.toLowerCase() : null;
    if (!this.active || !this.layer || !this.build || !this.data) return;
    const { systemIndex } = this.build;
    const indexToName = new Map<number, string>();
    for (const s of this.systems) {
      const i = systemIndex.get(s.metadata.file_path);
      if (i !== undefined) indexToName.set(i, s.metadata.name);
    }
    const dimForIndex = (i: number): boolean => {
      if (!this.searchTerm) return false;
      const name = indexToName.get(i);
      return name !== undefined && !name.toLowerCase().includes(this.searchTerm);
    };
    recomputeDimFlags(this.data.line, this.data.circle, dimForIndex);
    this.layer.updateDim(this.data.line.dim, this.data.circle.dim);
    this.map.triggerRepaint();
  }

  /** Hide/show reference shots + all-reference stations. */
  setReferenceShotsVisible(visible: boolean): void {
    this.referenceVisible = visible;
    this.layer?.setReferenceShotsVisible(visible);
    if (this.active) this.map.triggerRepaint();
  }

  /** Show/hide the whole custom survey (markers-only view). */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.layer?.setVisible(visible);
    if (this.active) this.map.triggerRepaint();
  }

  /** Apply a new station stroke color (theme change). Uniform-only. */
  setStrokeColor(css: string): void {
    this.strokeColor = packStroke(css);
    if (this.data) this.data.strokeColor = this.strokeColor;
    if (this.active) this.map.triggerRepaint();
  }

  /**
   * The system under a screen point (station-first then shot), or null. Returns
   * null unless the custom layer is active + visible, and honors the reference
   * shots visibility, so hidden features stay non-interactive.
   */
  pick(project: ProjectFn, x: number, y: number): GlobalHit | null {
    if (!this.active || !this.visible || !this.hitIndex) return null;
    return this.hitIndex.pick(project, x, y, {
      includeReference: this.referenceVisible,
      stationReach: STATION_REACH,
      shotReach: SHOT_REACH,
    });
  }

  destroy(): void {
    // Silent teardown: no onActiveChange(false) -> no stock republish, since
    // GlobalSurveyLayer clears the registry + removes the map right after.
    if (this.active) this.teardown(false);
    this.systems = [];
    this.metadataById = new Map();
    this.hitIndex = null;
    this.build = null;
    this.data = null;
  }
}
