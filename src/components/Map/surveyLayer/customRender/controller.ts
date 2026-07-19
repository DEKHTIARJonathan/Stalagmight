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
 * Hit-testing, labels, overlays, and the vector-tile publish path are untouched;
 * hit-testing still runs against the (now hidden) stock layers' logic-level data,
 * which is fine for a prototype (positions are identical).
 */
import type { Map as MaplibreMap } from 'maplibre-gl';
import type { GpsOrigin } from '../../../../types/config';
import type { SurveyData, SectionMetadata } from '../../../../types/survey-data';
import { STATION_FLAG_IS_ZERO_DATUM } from '../../../../types/survey-data';
import { debugLog } from '../../../../utils/debugLog';
import {
  resolveShotDisplayColor,
  resolveStationDisplayColor,
  resolveStationStrokeColor,
  type DisplayColorContext,
} from '../features';
import { packCssColor, type Rgba8 } from './colorPack';
import { computeMercatorAnchor } from './mercator';
import {
  buildStationLookup,
  projectStationsRel,
  buildLineBuffers,
  buildCircleBuffers,
} from './tessellate';
import { SurveyCustomLayer, type CustomRenderData } from './surveyCustomLayer';
import {
  readCustomRenderGate,
  CUSTOM_RENDER_SYNC_HOOK,
} from './gate';

/** Stock bulk layers hidden while the custom layer is on. */
const HIDDEN_STOCK_LAYERS = ['survey-shots', 'survey-shot-gradients', 'survey-stations'] as const;

export interface CustomSyncParams {
  surveyData: SurveyData;
  gpsOrigin: GpsOrigin | null;
  colorCtx: DisplayColorContext;
  /** CSS-pixel style sizes (mirror the stock layers' visual weights). */
  shotWidthPx: number;
  stationRadiusPx: number;
  stationStrokePx: number;
}

export class SurveyCustomController {
  private readonly map: MaplibreMap;
  private readonly layerId: string;
  private layer: SurveyCustomLayer | null = null;
  private active = false;
  private lastParams: CustomSyncParams | null = null;
  private hookInstalled = false;

  constructor(map: MaplibreMap, layerId = 'survey-custom-render') {
    this.map = map;
    this.layerId = layerId;
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

  private enable(data: CustomRenderData): void {
    if (!this.map.getStyle) return;
    this.layer = new SurveyCustomLayer(this.layerId, data);
    const beforeId = this.map.getLayer('survey-shots') ? 'survey-shots' : undefined;
    this.map.addLayer(this.layer, beforeId);
    this.setStockVisibility('none');
    this.active = true;
    this.map.triggerRepaint();
  }

  private disable(): void {
    if (this.map.getLayer?.(this.layerId)) this.map.removeLayer(this.layerId);
    this.layer = null;
    this.setStockVisibility('visible');
    this.active = false;
    this.map.triggerRepaint();
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
    const fillForStation = (g: number): Rgba8 => {
      const sectionId = surveyData.stationSectionIds[g]!;
      const sectionColor = sectionById.get(sectionId)?.color ?? stationDefault;
      return pack(resolveStationDisplayColor(surveyData, sectionColor, g, colorCtx));
    };
    const strokeForStation = (g: number): Rgba8 => {
      const isZeroDatum = (surveyData.stationFlags[g]! & STATION_FLAG_IS_ZERO_DATUM) !== 0;
      return pack(resolveStationStrokeColor(isZeroDatum, colorCtx));
    };

    const line = buildLineBuffers(surveyData, stationRel, lookup, colorForShot);
    const circle = buildCircleBuffers(surveyData, stationRel, fillForStation, strokeForStation);

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
    return data;
  }

  private installHook(): void {
    if (this.hookInstalled || typeof window === 'undefined') return;
    (window as unknown as Record<string, unknown>)[CUSTOM_RENDER_SYNC_HOOK] = () => {
      if (this.lastParams) this.sync(this.lastParams);
    };
    this.hookInstalled = true;
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
