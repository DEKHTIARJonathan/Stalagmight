// Deferred text-label filter restore for drag commits (#customRender FINISH
// label-flash fix).
//
// During a move drag the moving sections' TEXT layers (station/shot labels,
// section names, station/shot comments) are hidden from the stock symbol layers
// via a `setFilter` exclusion, because attached text is not previewed. On commit
// SurveyLayer.endDragPreview restores those filters. The geometry it restores is
// custom-rendered (a synchronous GPU upload), so it lands at the new position at
// once - but the TEXT layers read from the on-demand `stalx://` vector-tile label
// sources, whose resident tiles still hold the PRE-move coordinates until an
// asynchronous in-place reload replaces them. Restoring the text filters in the
// same synchronous flush block therefore paints the moved labels at their OLD
// position for the ~200ms until the label tiles reload (observed live).
//
// The fix keeps the text filters hidden past the flush and restores them only
// once the label sources have finished reloading with post-move data. This
// module holds the pure decision logic so it can be unit-tested without MapLibre.

import type maplibregl from 'maplibre-gl';

/** MapLibre symbol layers that render survey text from the `stalx://` label VT
 *  sources (`-shot-labels`, `-station-labels`, `-section-labels`). These are the
 *  layers whose drag-restore is deferred until the label tiles reload; every
 *  other drag-hidden layer (shots / stations / gradients / loop closures) is
 *  geometry and restores immediately. Comments share the label sources, so they
 *  belong here too. */
export const TEXT_LABEL_LAYER_IDS: ReadonlySet<string> = new Set([
  'survey-shot-labels',
  'survey-station-labels',
  'survey-labels',
  'survey-station-comments',
  'survey-shot-comments',
]);

/** Feature-group keys served by the label VT sources whose reload completion the
 *  deferred restore waits on. Keep in sync with SurveyLayer.GROUP_SOURCE label
 *  suffixes (`-section-labels`, `-shot-labels`, `-station-labels`). */
export const LABEL_VT_GROUPS: ReadonlySet<string> = new Set([
  'sectionLabelFeatures',
  'shotLabelFeatures',
  'stationLabelFeatures',
]);

/** Safety net: if a commit's label reloads never settle (they always resolve in
 *  practice), restore the text filters anyway after this long so labels can
 *  never be stranded hidden. */
export const LABEL_RESTORE_FALLBACK_MS = 2000;

export type DragFilterMap = Map<string, maplibregl.FilterSpecification | undefined>;

/**
 * Split a drag's saved bulk-layer filters into the geometry set (restored
 * immediately on drag end) and the text set (restored only once the label tiles
 * reload with post-move coordinates). Pure - unit-tested independently of the
 * live map.
 */
export function partitionDragFilters(
  saved: DragFilterMap,
): { geometry: DragFilterMap; text: DragFilterMap } {
  const geometry: DragFilterMap = new Map();
  const text: DragFilterMap = new Map();
  for (const [layerId, filter] of saved) {
    if (TEXT_LABEL_LAYER_IDS.has(layerId)) text.set(layerId, filter);
    else geometry.set(layerId, filter);
  }
  return { geometry, text };
}

/**
 * Whether a drag-end must defer the text-filter restore behind tile reloads.
 * Deferral only applies on a real commit that reloaded at least one label tile
 * source; an Escape/cancel, a rejected move, or an edit that changed no label
 * produced no reload and must restore synchronously (no tiles change on cancel,
 * so there is no old-position frame to hide).
 */
export function shouldDeferTextRestore(reloadCount: number): boolean {
  return reloadCount > 0;
}
