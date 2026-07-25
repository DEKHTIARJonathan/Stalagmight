// Custom drag-ghost render-data builder (#mem drag latency). Turns a captured
// DragPreviewSet + the current display state into the GhostRenderData the ghost
// WebGL layer uploads: resolved colors (base / severity / depth, or the analytical
// overlay ramp), the preview's 0.85 opacity baked in, device-px sizes, display-
// toggle filtering, and the grabbed-feature highlight pass. Kept out of
// SurveyLayer (which only assembles the context) to hold its size budget.

import type { MovingEnd, DragPreviewSet } from './dragPreviewSource';
import type { OverlayColorInput } from './displayColor';
import { makeOverlayColor } from './customRender/overlayColor';
import { packCssColor, type Rgba8 } from './customRender/colorPack';
import { buildGhostBuffers } from './customRender/ghostTessellate';
import type { GhostRenderData } from './customRender/surveyGhostLayer';
import { buildGhostHighlights } from './dragGhostHighlight';

/** Everything the builder needs from SurveyLayer (state + a few existing methods).
 *  Geometry + color for highlights come from the interact-overlay feature builders
 *  (dragOverlayOffset is 0 at drag start, so they return un-offset coords). */
export interface GhostRenderContext {
  dpr: number;
  themeColors: { grayLine: string; selectHighlight: string; hoverHighlight: string };
  overlay: OverlayColorInput | null;
  shotsVisible: boolean;
  stationsVisible: boolean;
  selShotWidth: number;
  hoverShotWidth: number;
  selRadius: number;
  hoverRadius: number;
  hoveredShotId: string | null;
  selectedShotId: string | null;
  hoveredStationId: string | null;
  selectedStationId: string | null;
  movingEndForShot: (id: string) => MovingEnd | undefined;
  isMovingStation: (id: string) => boolean;
  parseFid: (id: string) => number | null;
  isAnchored: (fid: number) => boolean;
  isShotImmovable: (fid: number) => boolean;
  isStationImmovable: (fid: number) => boolean;
  shotFeature: (id: string, width: number) => GeoJSON.Feature | null;
  stationFeature: (id: string, style: 'hover' | 'selected') => GeoJSON.Feature | null;
}

/** Build the ghost render data (buffers + device-px sizes) for a captured set. */
export function buildGhostRenderData(set: DragPreviewSet, ctx: GhostRenderContext): GhostRenderData {
  const { overlay } = ctx;
  const ramp = overlay ? makeOverlayColor(overlay, ctx.themeColors.grayLine) : null;
  // Shared color: the analytical ramp in distance/gas mode, else the feature's own
  // display color. Features without the value prop (closures) fall through.
  const colorFromProps = (props: Record<string, unknown>): Rgba8 => {
    if (ramp && overlay) {
      const v = props[overlay.mode === 'distance' ? 'dist' : 'gasReach'];
      if (typeof v === 'number') return ramp(v);
    }
    return packCssColor(String(props.color ?? '#ffffff'));
  };

  // Respect display toggles: skip the kinds whose layer is hidden. Resolved at
  // drag start (a mid-drag toggle is an accepted edge case). Closures follow the
  // stations toggle (setShowStations governs the loop-closures layer).
  const filtered: DragPreviewSet = {
    features: set.features.filter((f) =>
      f.properties.kind === 'shot' ? ctx.shotsVisible : ctx.stationsVisible,
    ),
  };

  const shotWidth = ctx.selShotWidth;
  const highlights = buildGhostHighlights({
    hoveredShotId: ctx.hoveredShotId,
    selectedShotId: ctx.selectedShotId,
    hoveredStationId: ctx.hoveredStationId,
    selectedStationId: ctx.selectedStationId,
    shotsVisible: ctx.shotsVisible,
    stationsVisible: ctx.stationsVisible,
    selShotWidth: ctx.selShotWidth,
    hoverShotWidth: ctx.hoverShotWidth,
    selRadius: ctx.selRadius,
    hoverRadius: ctx.hoverRadius,
    hoverStroke: packCssColor(ctx.themeColors.hoverHighlight),
    selStroke: packCssColor(ctx.themeColors.selectHighlight),
    movingEndForShot: ctx.movingEndForShot,
    isMovingStation: ctx.isMovingStation,
    parseFid: ctx.parseFid,
    isAnchored: ctx.isAnchored,
    isShotImmovable: ctx.isShotImmovable,
    isStationImmovable: ctx.isStationImmovable,
    shotFeature: ctx.shotFeature,
    stationFeature: ctx.stationFeature,
    colorFromProps,
  });

  const { anchorX, anchorY, line, circle } = buildGhostBuffers(
    filtered,
    {
      fillAlpha: 0.85,
      strokeColor: packCssColor(ctx.themeColors.selectHighlight),
      widthMulFor: (f) => (f.properties.kind === 'closure' ? 3 / shotWidth : 1),
      colorFor: (f) => colorFromProps(f.properties),
    },
    highlights,
  );

  return {
    anchorX, anchorY, line, circle,
    lineHalfWidthPx: (shotWidth / 2) * ctx.dpr,
    circleRadiusPx: ctx.selRadius * ctx.dpr,
    circleStrokePx: 2.5 * ctx.dpr,
    aaPx: ctx.dpr,
  };
}
