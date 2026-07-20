// Drag-preview MapLibre layers (#mem drag fixes).
//
// The unified drag-preview source (`survey-drag-preview`) is drawn by a fixed
// stack of layers, split out of SurveyLayer.tsx to keep that file off its size
// ceiling and to hold the (verbose) layer specs in one testable place.
//
// Geometry layers (shots / closures / stations) render the captured MOVING
// coordinates: the source is rebuilt each frame via a single `setData`, so the
// tiler clips the real moved shape (no background wedges at large offsets).
//
// Text layers (station / shot labels, section names, station / shot comments)
// render at the STATIC captured anchor and follow the drag with a per-frame
// `text-translate` paint uniform instead. MapLibre re-runs symbol placement
// asynchronously and throttled, so moving a label by `setData` leaves its glyphs
// frozen at the last-placed spot for the whole drag; a GPU `text-translate`
// shifts the drawn glyphs instantly so the text tracks the geometry smoothly.
// A stretching shot's midpoint moves half as far as its single moving endpoint,
// so `shotLabel` / `shotComment` split into a full layer and a half layer that
// take `[dx, dy]` and `[dx/2, dy/2]` respectively.

import type maplibregl from 'maplibre-gl';
import type { ExpressionSpecification } from 'maplibre-gl';
import { dragLabelTranslate } from './dragPreviewSource';

// Two sources: the geometry source is rebuilt every frame (setData) so the tiler
// clips the moved shapes; the label source is set ONCE at drag start and only
// text-translated. They MUST be separate — a per-frame setData re-parses the
// whole source and un-places its symbols, so labels sharing the geometry source
// would re-freeze every frame despite the static anchors (that is the bug this
// split fixes).
export const DRAG_PREVIEW_SOURCE = 'survey-drag-preview';
export const DRAG_PREVIEW_LABEL_SOURCE = 'survey-drag-preview-labels';
const SHOTS_LAYER = 'survey-drag-preview-shots';
const CLOSURES_LAYER = 'survey-drag-preview-closures';
const STATIONS_LAYER = 'survey-drag-preview-stations';

/** One preview text layer: which feature `kind` it draws, which stock layer its
 *  layout (size / offset / anchor / visibility) is copied from, and how it
 *  follows the drag. `half` null = the kind never stretches (whole-offset only);
 *  false / true = the full / half slice of a kind that can stretch. */
interface LabelLayerDef {
  id: string;
  kind: string;
  /** Key into DragPreviewLayerCtx.stock for the layout-copy source. */
  stock: keyof DragPreviewLayerCtx['stock'];
  half: boolean | null;
}

const LABEL_LAYERS: LabelLayerDef[] = [
  { id: 'survey-drag-preview-station-labels', kind: 'stationLabel', stock: 'stationLabels', half: null },
  { id: 'survey-drag-preview-shot-labels', kind: 'shotLabel', stock: 'shotLabels', half: false },
  { id: 'survey-drag-preview-shot-labels-half', kind: 'shotLabel', stock: 'shotLabels', half: true },
  { id: 'survey-drag-preview-section-labels', kind: 'sectionLabel', stock: 'sectionLabels', half: null },
  { id: 'survey-drag-preview-station-comments', kind: 'stationComment', stock: 'stationComments', half: null },
  { id: 'survey-drag-preview-shot-comments', kind: 'shotComment', stock: 'shotComments', half: false },
  { id: 'survey-drag-preview-shot-comments-half', kind: 'shotComment', stock: 'shotComments', half: true },
];

const ALL_LAYER_IDS = [
  SHOTS_LAYER,
  CLOSURES_LAYER,
  STATIONS_LAYER,
  ...LABEL_LAYERS.map((l) => l.id),
];

/** Everything the layer specs need from SurveyLayer without importing it. */
export interface DragPreviewLayerCtx {
  /** shots + stations color (plain `['get','color']` or an analytical ramp). */
  colorExpr: ExpressionSpecification;
  shotWidth: number;
  stationRadius: number;
  selectHighlight: string;
  textHalo: string;
  /** Stock label layer ids to copy per-kind layout from. */
  stock: {
    stationLabels: string;
    shotLabels: string;
    sectionLabels: string;
    stationComments: string;
    shotComments: string;
  };
}

/** Add one preview text layer, copying layout (size / offset / anchor /
 *  visibility) from its stock counterpart so the preview text keeps its look,
 *  and following the drag via a viewport-space `text-translate`. */
function addLabelLayer(map: maplibregl.Map, def: LabelLayerDef, ctx: DragPreviewLayerCtx): void {
  const stockId = ctx.stock[def.stock];
  const vis = map.getLayoutProperty(stockId, 'visibility') ?? 'visible';
  const textSize = map.getLayoutProperty(stockId, 'text-size') ?? 11;
  const textOffset = map.getLayoutProperty(stockId, 'text-offset');
  const textAnchor = map.getLayoutProperty(stockId, 'text-anchor');
  const maxWidth = map.getLayoutProperty(stockId, 'text-max-width');
  const layout: Record<string, unknown> = {
    'text-field': ['get', 'label'],
    'text-font': ['Open Sans Regular'],
    'text-size': textSize,
    'text-allow-overlap': true,
    'visibility': vis as 'visible' | 'none',
  };
  if (textOffset != null) layout['text-offset'] = textOffset;
  if (textAnchor != null) layout['text-anchor'] = textAnchor;
  if (maxWidth != null) layout['text-max-width'] = maxWidth;
  const filter: maplibregl.FilterSpecification = def.half === null
    ? ['==', ['get', 'kind'], def.kind]
    : ['all', ['==', ['get', 'kind'], def.kind], ['==', ['get', 'half'], def.half]];
  map.addLayer({
    id: def.id,
    type: 'symbol',
    source: DRAG_PREVIEW_LABEL_SOURCE,
    filter,
    layout: layout as NonNullable<maplibregl.SymbolLayerSpecification['layout']>,
    paint: {
      'text-color': ['get', 'color'],
      'text-halo-color': ctx.textHalo,
      'text-halo-width': 1.5,
      'text-opacity': 0.85,
      // Screen-space follow: `map` anchor would rotate/scale the offset with the
      // camera and diverge from the pixel-space drag delta.
      'text-translate-anchor': 'viewport',
      'text-translate': [0, 0],
    },
  });
}

/** Create the unified drag-preview source and its layers (idempotent). The
 *  layers filter one source by feature `kind`; z-order is lines (shots,
 *  closures) below circles (stations) below text, matching the bulk stack. */
export function createDragPreviewLayers(map: maplibregl.Map, ctx: DragPreviewLayerCtx): void {
  if (map.getSource(DRAG_PREVIEW_SOURCE)) removeDragPreviewLayers(map);
  map.addSource(DRAG_PREVIEW_SOURCE, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addSource(DRAG_PREVIEW_LABEL_SOURCE, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: SHOTS_LAYER,
    type: 'line',
    source: DRAG_PREVIEW_SOURCE,
    filter: ['==', ['get', 'kind'], 'shot'],
    paint: {
      'line-color': ctx.colorExpr,
      'line-width': ctx.shotWidth,
      'line-opacity': 0.85,
    },
  });
  map.addLayer({
    id: CLOSURES_LAYER,
    type: 'line',
    source: DRAG_PREVIEW_SOURCE,
    filter: ['==', ['get', 'kind'], 'closure'],
    paint: {
      'line-color': ['get', 'color'],
      'line-width': 3,
      'line-opacity': 0.85,
      'line-dasharray': [6, 4],
    },
  });
  map.addLayer({
    id: STATIONS_LAYER,
    type: 'circle',
    source: DRAG_PREVIEW_SOURCE,
    filter: ['==', ['get', 'kind'], 'station'],
    paint: {
      'circle-color': ctx.colorExpr,
      'circle-radius': ctx.stationRadius,
      'circle-stroke-color': ctx.selectHighlight,
      'circle-stroke-width': 2.5,
      'circle-opacity': 0.85,
    },
  });
  for (const def of LABEL_LAYERS) addLabelLayer(map, def, ctx);
}

/** Set the label source ONCE at drag start (static anchors). It is not touched
 *  again during the drag; the follow is the per-frame `text-translate`. */
export function setDragPreviewLabels(map: maplibregl.Map, fc: GeoJSON.FeatureCollection): void {
  const src = map.getSource(DRAG_PREVIEW_LABEL_SOURCE);
  if (src && 'setData' in src) (src as maplibregl.GeoJSONSource).setData(fc);
}

/** Remove the unified drag-preview sources and layers (idempotent). */
export function removeDragPreviewLayers(map: maplibregl.Map): void {
  for (const id of ALL_LAYER_IDS) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(DRAG_PREVIEW_SOURCE)) map.removeSource(DRAG_PREVIEW_SOURCE);
  if (map.getSource(DRAG_PREVIEW_LABEL_SOURCE)) map.removeSource(DRAG_PREVIEW_LABEL_SOURCE);
}

/** Point every preview text layer at the current drag offset. Full layers take
 *  the whole `[dx, dy]`; half layers (stretching-shot midpoints) take half. A
 *  GPU uniform, so the text follows without a symbol re-placement pass. */
export function applyDragLabelTranslate(map: maplibregl.Map, dx: number, dy: number): void {
  for (const def of LABEL_LAYERS) {
    if (!map.getLayer(def.id)) continue;
    map.setPaintProperty(def.id, 'text-translate', dragLabelTranslate(dx, dy, def.half === true));
  }
}
