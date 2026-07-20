/**
 * Shared per-feature color resolvers for the custom-render build + incremental
 * paths (#customRender). Factored out of the controller's `build()` so the
 * incremental section/station recompute (incremental.ts) resolves colors with
 * the EXACT same closures the full build uses — a prerequisite for the
 * byte-identical incremental guarantee (a moved section rebuilt incrementally
 * must be indistinguishable from a full rebuild of the same geometry).
 *
 * Pure (no GL, no DOM): reads `SurveyData` + a `DisplayColorContext`, returns
 * packed RGBA resolvers keyed by global shot / station index.
 */
import type { SurveyData, SectionMetadata } from '../../../../types/survey-data';
import { STATION_FLAG_IS_ZERO_DATUM } from '../../../../types/survey-data';
import {
  resolveShotDisplayColor,
  resolveShotEndpointColors,
  resolveStationDisplayColor,
  resolveStationStrokeColor,
  type DisplayColorContext,
} from '../features';
import { packCssColor, type Rgba8 } from './colorPack';

export interface ColorResolvers {
  /** Flat whole-segment shot color (section-color / severity mode). */
  colorForShot: (shotGlobalIdx: number, sectionId: number) => Rgba8;
  /** Per-endpoint `[from, to]` shot colors (depth-gradient mode). */
  colorForShotEndpoints: (shotGlobalIdx: number, sectionId: number) => readonly [Rgba8, Rgba8];
  fillForStation: (globalIdx: number) => Rgba8;
  strokeForStation: (globalIdx: number) => Rgba8;
  /** True in depth mode: the line builder should take the endpoint resolver so
   *  the GPU interpolates the shot's depth ramp (stock survey-shot-gradients). */
  useDepthEndpoints: boolean;
  /** Section id -> metadata, reused by the incremental diff (section color). */
  sectionById: Map<number, SectionMetadata>;
}

/**
 * Build the packed-color resolvers for one (surveyData, colorCtx) pair. A small
 * append cache parses each distinct CSS color once (the palette is tiny vs the
 * vertex count). The build path and the incremental recompute each call this so
 * their resolved bytes match exactly.
 */
export function makeColorResolvers(
  surveyData: SurveyData,
  colorCtx: DisplayColorContext,
): ColorResolvers {
  const sectionById = new Map<number, SectionMetadata>();
  for (const s of surveyData.sections) sectionById.set(s.id, s);
  const stationDefault = colorCtx.themeColors.stationDefault;

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

  return {
    colorForShot,
    colorForShotEndpoints,
    fillForStation,
    strokeForStation,
    useDepthEndpoints,
    sectionById,
  };
}
