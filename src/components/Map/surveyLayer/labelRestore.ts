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

/**
 * Section ids present in `prev` but absent from `next` - the sections a flush
 * removed (delete section / delete last-shot-of-section, or undo of an add).
 * These are the ids whose stale text labels must be hidden until the label tiles
 * reload without them. Pure - unit-tested independently of the live map.
 */
export function diffRemovedSectionIds(
  prev: readonly { id: number }[],
  next: readonly { id: number }[],
): number[] {
  if (prev.length === 0) return [];
  const kept = new Set<number>();
  for (const s of next) kept.add(s.id);
  const removed: number[] = [];
  for (const s of prev) if (!kept.has(s.id)) removed.push(s.id);
  return removed;
}

/** A `setFilter` exclusion hiding features whose `sectionId` is in `sectionIds`
 *  (the label VT sources carry `sectionId` per feature). Mirrors the segment-drag
 *  exclusion so the same layers hide the same way. */
export function buildSectionLabelExclusion(
  sectionIds: readonly number[],
): maplibregl.FilterSpecification {
  return ['!', ['in', ['get', 'sectionId'], ['literal', [...sectionIds]]]] as unknown as maplibregl.FilterSpecification;
}

/** Compose an exclusion onto a layer's existing filter (preserving reference /
 *  zoom gating) with `all`, or use it directly when there is no base filter. */
export function composeLabelFilter(
  existing: maplibregl.FilterSpecification | undefined,
  exclusion: maplibregl.FilterSpecification,
): maplibregl.FilterSpecification {
  return existing && typeof existing === 'object'
    ? (['all', existing, exclusion] as unknown as maplibregl.FilterSpecification)
    : exclusion;
}

/** Narrow map surface the controller needs (filter get/set + layer existence). */
export type LabelFilterMap = Pick<maplibregl.Map, 'getLayer' | 'getFilter' | 'setFilter'>;

/**
 * Deferred text-label filter machinery shared by the drag-commit FINISH fix and
 * the delete/undo removal fix (#customRender straggler). Both cases hide some
 * text-label layers now and restore them only once the `stalx://` label sources
 * finish reloading, so no stale label is ever painted in the gap:
 *
 *   - Drag commit: the moved sections' labels are hidden by SurveyLayer during
 *     the drag; on commit it hands the saved base filters here via
 *     {@link deferRestore} to release once the reloads settle.
 *   - Delete / undo-of-add: geometry is custom-rendered (removed synchronously in
 *     the flush) but the label tiles still hold the removed sections until an
 *     async reload. {@link hideRemovedSections} hides them in that same frame;
 *     {@link settleRemoval} releases once the flush's label reloads land.
 *
 * A monotonic generation guards the pending restore so a superseding op owns the
 * filters and a late settle from a superseded one no-ops; a fallback timer means
 * labels can never be stranded hidden if a reload never resolves.
 */
export class LabelRestoreController {
  private pending: { filters: DragFilterMap; generation: number; timeout: ReturnType<typeof setTimeout> } | null =
    null;
  /** Base filters hidden by {@link hideRemovedSections}, awaiting settleRemoval. */
  private held: DragFilterMap | null = null;
  private generation = 0;

  constructor(private readonly map: LabelFilterMap) {}

  /**
   * Schedule the deferred restore of `filters` behind `reloads`. When no label
   * tile reloaded (Escape / cancel / no label change) restore synchronously -
   * there is no stale-tile frame to hide. A superseding call flushes the prior
   * pending first so nothing is stranded.
   */
  deferRestore(filters: DragFilterMap, reloads: Promise<unknown>[] | null): void {
    if (filters.size === 0) return;
    if (!reloads || !shouldDeferTextRestore(reloads.length)) {
      this.restore(filters);
      return;
    }
    this.flushPending();
    const generation = ++this.generation;
    const timeout = setTimeout(() => this.settle(generation), LABEL_RESTORE_FALLBACK_MS);
    this.pending = { filters, generation, timeout };
    void Promise.allSettled(reloads).then(() => this.settle(generation));
  }

  /**
   * Hide the removed sections' text-label layers (composing the exclusion onto
   * each layer's base filter), saving the base filters for a later
   * {@link settleRemoval}. Force-applies any pending restore first so the saved
   * filters are the true base, not an already-hidden state. Returns true when at
   * least one layer was hidden.
   */
  hideRemovedSections(sectionIds: readonly number[]): boolean {
    if (sectionIds.length === 0) return false;
    this.flushPending();
    const exclusion = buildSectionLabelExclusion(sectionIds);
    const saved: DragFilterMap = new Map();
    for (const layerId of TEXT_LABEL_LAYER_IDS) {
      if (!this.map.getLayer(layerId)) continue;
      const existing = this.map.getFilter(layerId) ?? undefined;
      saved.set(layerId, existing);
      this.map.setFilter(layerId, composeLabelFilter(existing, exclusion));
    }
    if (saved.size === 0) return false;
    this.held = saved;
    return true;
  }

  /** Release the filters hidden by {@link hideRemovedSections}, deferred behind
   *  `reloads` (this flush's label-source reloads). No-op when nothing is held. */
  settleRemoval(reloads: Promise<unknown>[]): void {
    const held = this.held;
    if (!held) return;
    this.held = null;
    this.deferRestore(held, reloads);
  }

  /** Force-apply any queued restore now (a superseding op captures true base
   *  filters). No-op when nothing is queued. */
  flushPending(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timeout);
    this.restore(pending.filters);
  }

  /** Drop any pending timer without restoring (teardown - the map is going away).
   *  The setFilter is getLayer-guarded elsewhere, so this only frees the handle. */
  dispose(): void {
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending = null;
    }
    this.held = null;
  }

  /** Apply a queued restore if it still belongs to `generation` (a superseding op
   *  has taken over the filters otherwise -> skip). */
  private settle(generation: number): void {
    if (!this.pending || this.pending.generation !== generation) return;
    this.flushPending();
  }

  /** Re-apply saved base filters to their text (label / comment) layers. */
  private restore(filters: DragFilterMap): void {
    for (const [layerId, saved] of filters) {
      if (this.map.getLayer(layerId)) this.map.setFilter(layerId, saved ?? null);
    }
  }
}
