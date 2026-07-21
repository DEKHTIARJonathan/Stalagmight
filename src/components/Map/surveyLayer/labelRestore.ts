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
import type { SurveyData } from '../../../types/survey-data';

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

/** Label layers reading the `-shot-labels` source (features carry sectionId +
 *  shotId): both the shot labels and the shot comments render from it, so a
 *  per-shot removal exclusion targets both. */
export const SHOT_LABEL_LAYER_IDS: ReadonlySet<string> = new Set([
  'survey-shot-labels',
  'survey-shot-comments',
]);

/** Label layers reading the `-station-labels` source (features carry sectionId +
 *  stationIndex): both the station labels and the station comments render from
 *  it, so a station removal exclusion targets both. */
export const STATION_LABEL_LAYER_IDS: ReadonlySet<string> = new Set([
  'survey-station-labels',
  'survey-station-comments',
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

/** A `setFilter` exclusion hiding shot-label features whose `sectionId:shotId`
 *  composite is in `shotKeys` (the `-shot-labels` source carries both props).
 *  Keyed on `shotId` because it is STABLE across a deletion (unlike a station's
 *  positional index, which renumbers), so a removed shot's label can be targeted
 *  exactly. */
export function buildShotLabelExclusion(
  shotKeys: readonly string[],
): maplibregl.FilterSpecification {
  const needle = ['concat', ['to-string', ['get', 'sectionId']], ':', ['to-string', ['get', 'shotId']]];
  return ['!', ['in', needle, ['literal', [...shotKeys]]]] as unknown as maplibregl.FilterSpecification;
}

/** Compose a layer's true base filter with zero or more removal exclusions via
 *  `all` (nulls skipped), preserving the base's reference / zoom gating. */
export function composeLabelFilters(
  base: maplibregl.FilterSpecification | undefined,
  exclusions: ReadonlyArray<maplibregl.FilterSpecification | null>,
): maplibregl.FilterSpecification | null {
  const parts = exclusions.filter((e): e is maplibregl.FilterSpecification => e != null);
  if (parts.length === 0) return base ?? null;
  const withBase = base && typeof base === 'object' ? [base, ...parts] : parts;
  return (withBase.length === 1 ? withBase[0]! : ['all', ...withBase]) as unknown as maplibregl.FilterSpecification;
}

/** Per-feature removals within SURVIVING sections (whole-section removals are
 *  handled by the persistent section-level exclusion). Returned by
 *  {@link diffRemovedFeatures} for the reload-settled per-feature hide. */
export interface RemovedFeatures {
  /** Shots gone this flush, keyed by their STABLE (sectionId, shotId). */
  shots: Array<{ sectionId: number; shotId: number }>;
  /** Sections that lost >= 1 station. Station labels are hidden WHOLESALE per
   *  section (not per index): deleting a shot removes the endpoint station AND
   *  renumbers every higher index down, so a specific old index cannot be
   *  identified from a set-diff and an index-keyed hide would hit the wrong
   *  label after reload. The reload-settled drop bridges only the reload window,
   *  after which the tiles carry the renumbered, truthful labels. */
  stationSections: number[];
}

/**
 * Diff two survey SoAs for per-feature removals inside surviving sections. A
 * shot is removed when its (sectionId, shotId) is absent from `next`; a section
 * "lost a station" when its station count dropped. Sections absent from `next`
 * entirely are skipped (the section-level exclusion owns those). Pure - O(shots +
 * stations), unit-tested without MapLibre.
 */
export function diffRemovedFeatures(prev: SurveyData | null, next: SurveyData): RemovedFeatures {
  const shots: Array<{ sectionId: number; shotId: number }> = [];
  const stationSections: number[] = [];
  if (!prev) return { shots, stationSections };
  // Fast path (every non-deletion flush): a per-feature removal strictly reduces
  // the shot or station total, so skip the O(N) id diff when neither shrank. A
  // rare add+delete in one flush falls back to the pre-existing straggler.
  if (next.shotCount >= prev.shotCount && next.stationCount >= prev.stationCount) {
    return { shots, stationSections };
  }
  const survivingSectionIds = new Set<number>();
  for (const s of next.sections) survivingSectionIds.add(s.id);

  // Removed shots: prev shot in a surviving section whose (sectionId, shotId) is
  // no longer present in next.
  const nextShotIds = new Map<number, Set<number>>();
  for (let i = 0; i < next.shotCount; i++) {
    const sid = next.shotSectionIds[i]!;
    let set = nextShotIds.get(sid);
    if (!set) {
      set = new Set();
      nextShotIds.set(sid, set);
    }
    set.add(next.shotIds[i]!);
  }
  for (let i = 0; i < prev.shotCount; i++) {
    const sid = prev.shotSectionIds[i]!;
    if (!survivingSectionIds.has(sid)) continue;
    if (!nextShotIds.get(sid)?.has(prev.shotIds[i]!)) shots.push({ sectionId: sid, shotId: prev.shotIds[i]! });
  }

  // Sections that lost a station: compare per-section station counts.
  const prevCounts = new Map<number, number>();
  for (let g = 0; g < prev.stationCount; g++) {
    const sid = prev.stationSectionIds[g]!;
    prevCounts.set(sid, (prevCounts.get(sid) ?? 0) + 1);
  }
  const nextCounts = new Map<number, number>();
  for (let g = 0; g < next.stationCount; g++) {
    const sid = next.stationSectionIds[g]!;
    nextCounts.set(sid, (nextCounts.get(sid) ?? 0) + 1);
  }
  for (const [sid, prevCount] of prevCounts) {
    if (!survivingSectionIds.has(sid)) continue;
    if ((nextCounts.get(sid) ?? 0) < prevCount) stationSections.push(sid);
  }
  return { shots, stationSections };
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
 *     {@link deferRestore} to release once the reloads settle (a monotonic
 *     generation guards the pending restore; a fallback timer means labels can
 *     never be stranded hidden if a reload never resolves).
 *   - Delete / undo-of-add: geometry is custom-rendered (removed synchronously in
 *     the flush) but the label tiles still hold the removed sections until an
 *     async reload that does not reliably purge every tile. {@link
 *     applyRemovedExclusion} instead keeps a persistent per-section exclusion,
 *     re-derived every flush, that hides the removed labels in the geometry frame
 *     and only drops when the section is re-added - no tile-timing dependence.
 */
export class LabelRestoreController {
  private pending: { filters: DragFilterMap; generation: number; timeout: ReturnType<typeof setTimeout> } | null =
    null;
  private generation = 0;
  /** Sections deleted (and not yet re-added) whose labels are excluded right now.
   *  Persistent across flushes: the exclusion is re-derived from this set every
   *  flush, so a removed section's labels stay hidden until it is re-added - no
   *  reliance on tile-reload / fade timing (which un-hides labels still resident
   *  in not-yet-replaced tiles). */
  private removedIds = new Set<number>();
  /** Per-feature TRANSIENT exclusions bridging only the label-tile reload window
   *  (dropped once this flush's reloads settle - see {@link settleFeatureExclusion}).
   *  `removedShotKeys` are stable `sectionId:shotId`; `removedStationSectionIds`
   *  hide a section's station labels wholesale because station indices renumber
   *  on delete (an index-keyed hide would target the wrong label after reload). */
  private removedShotKeys = new Set<string>();
  private removedStationSectionIds = new Set<number>();
  /** Generation guard + fallback timer for the transient per-feature drop, so a
   *  newer removal supersedes an older settle and a hide is never stranded. */
  private featurePending: { generation: number; timeout: ReturnType<typeof setTimeout> } | null = null;
  private featureGeneration = 0;
  /** Previous flush's survey SoA, tracked here (updated every flush that reports
   *  removals) so the caller passes only the current SoA - the per-feature diff
   *  needs the immediately-preceding one, which the caller has already
   *  overwritten by the time the removal exclusion is applied. */
  private lastFlushSurveyData: SurveyData | null = null;
  /** True base filters (no removal exclusion) of the text layers, captured once
   *  when the first removal is applied and restored when every set empties. */
  private removedBaseFilters: DragFilterMap | null = null;

  constructor(private readonly map: LabelFilterMap) {}

  /**
   * Schedule the deferred restore of `filters` behind `reloads` (drag-commit
   * path). When no label tile reloaded (Escape / cancel / no label change)
   * restore synchronously - there is no stale-tile frame to hide. A superseding
   * call flushes the prior pending first so nothing is stranded.
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
   * Maintain the persistent exclusion that hides deleted sections' text labels.
   * Called every custom-render flush: `removedThisFlush` are the sections this
   * flush dropped; `sections` is the surviving set (so a re-added section - undo
   * of a delete - drops out and its labels return). The exclusion is re-derived
   * from the accumulated {@link removedIds} and re-applied to each text layer, so
   * a removed section's labels are hidden in the same frame its geometry vanishes
   * and NEVER fade back in from stale tiles; when the set empties the true base
   * filters are restored. Timing-independent by construction. No-op until a first
   * removal, so ordinary flushes cost nothing.
   */
  applyRemovedExclusion(
    removedThisFlush: readonly number[],
    sections: readonly { id: number }[],
    surveyData?: SurveyData,
  ): void {
    // Per-feature removals (single shot / station deletions in a surviving
    // section) hide by (sectionId, shotId) / per-section station labels until the
    // reload settles. Diffed against the tracked previous SoA, then advance it.
    if (surveyData) {
      this.applyRemovedFeatureExclusion(diffRemovedFeatures(this.lastFlushSurveyData, surveyData));
      this.lastFlushSurveyData = surveyData;
    }
    if (removedThisFlush.length === 0 && this.removedIds.size === 0) return;
    for (const id of removedThisFlush) this.removedIds.add(id);
    if (this.removedIds.size > 0) {
      const present = new Set<number>();
      for (const s of sections) present.add(s.id);
      for (const id of this.removedIds) if (present.has(id)) this.removedIds.delete(id);
    }
    this.reapplyExclusions();
  }

  /**
   * Hide the labels of individually-removed shots / stations in surviving
   * sections, in the same frame their custom-rendered geometry vanished, so no
   * stale label lingers on the resident tiles until the async reload. Called
   * synchronously in the flush (BEFORE the worker rebuild). The hide is TRANSIENT:
   * {@link settleFeatureExclusion} drops it once this flush's label tiles reload,
   * because station indices renumber on delete and a persistent index-keyed hide
   * would target the wrong (shifted) label after reload. No-op with nothing
   * removed, so ordinary flushes cost nothing.
   */
  applyRemovedFeatureExclusion(removed: RemovedFeatures): void {
    if (removed.shots.length === 0 && removed.stationSections.length === 0) return;
    for (const s of removed.shots) this.removedShotKeys.add(`${s.sectionId}:${s.shotId}`);
    for (const sid of removed.stationSections) this.removedStationSectionIds.add(sid);
    this.reapplyExclusions();
    // Arm the fallback drop; the reload-settled drop (settleFeatureExclusion)
    // supersedes it when this flush's reloads arrive.
    if (this.featurePending) clearTimeout(this.featurePending.timeout);
    const generation = ++this.featureGeneration;
    const timeout = setTimeout(() => this.dropFeatureExclusion(generation), LABEL_RESTORE_FALLBACK_MS);
    this.featurePending = { generation, timeout };
  }

  /**
   * Drop the transient per-feature exclusion once THIS flush's label tiles have
   * reloaded (the removed feature gone, neighbors renumbered ⇒ truthful). Called
   * from endApplyFeatures with the flush's label reloads; a no-op when no
   * per-feature hide is pending. When no label tile reloaded (labels not built)
   * the fallback timer drops the harmless hide instead.
   */
  settleFeatureExclusion(reloads: Promise<unknown>[]): void {
    const pending = this.featurePending;
    if (!pending || reloads.length === 0) return;
    const generation = pending.generation;
    void Promise.allSettled(reloads).then(() => this.dropFeatureExclusion(generation));
  }

  /** Clear the transient per-feature sets (if `generation` is still current) and
   *  reapply, restoring the affected layers to base + any persistent section hide. */
  private dropFeatureExclusion(generation: number): void {
    if (!this.featurePending || this.featurePending.generation !== generation) return;
    clearTimeout(this.featurePending.timeout);
    this.featurePending = null;
    this.removedShotKeys.clear();
    this.removedStationSectionIds.clear();
    this.reapplyExclusions();
  }

  /**
   * Single authority that (re)derives every text layer's filter from the base +
   * the persistent section exclusion + the transient per-feature exclusions.
   * When all three sets are empty the captured base filters are restored and
   * dropped. Called by both the section and per-feature entry points so they
   * never clobber each other.
   */
  private reapplyExclusions(): void {
    const active =
      this.removedIds.size > 0 || this.removedShotKeys.size > 0 || this.removedStationSectionIds.size > 0;
    if (!active) {
      // Everything re-added / reload-settled: restore the captured base and drop it.
      if (this.removedBaseFilters) this.restore(this.removedBaseFilters);
      this.removedBaseFilters = null;
      return;
    }
    // Capture the true base once (current filters carry no removal exclusion yet;
    // a delete never overlaps a drag, so this is the real zoom-gating base).
    if (!this.removedBaseFilters) {
      this.removedBaseFilters = new Map();
      for (const layerId of TEXT_LABEL_LAYER_IDS) {
        if (!this.map.getLayer(layerId)) continue;
        this.removedBaseFilters.set(layerId, this.map.getFilter(layerId) ?? undefined);
      }
    }
    const sectionExcl = this.removedIds.size > 0 ? buildSectionLabelExclusion([...this.removedIds]) : null;
    const shotExcl = this.removedShotKeys.size > 0 ? buildShotLabelExclusion([...this.removedShotKeys]) : null;
    const stationExcl =
      this.removedStationSectionIds.size > 0 ? buildSectionLabelExclusion([...this.removedStationSectionIds]) : null;
    for (const [layerId, base] of this.removedBaseFilters) {
      if (!this.map.getLayer(layerId)) continue;
      const exclusions = [sectionExcl];
      if (SHOT_LABEL_LAYER_IDS.has(layerId)) exclusions.push(shotExcl);
      if (STATION_LABEL_LAYER_IDS.has(layerId)) exclusions.push(stationExcl);
      this.map.setFilter(layerId, composeLabelFilters(base, exclusions));
    }
  }

  /** Force-apply any queued drag restore now (a superseding op captures true base
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
    if (this.featurePending) {
      clearTimeout(this.featurePending.timeout);
      this.featurePending = null;
    }
    this.removedIds.clear();
    this.removedShotKeys.clear();
    this.removedStationSectionIds.clear();
    this.removedBaseFilters = null;
    this.lastFlushSurveyData = null;
  }

  /** Apply a queued drag restore if it still belongs to `generation` (a
   *  superseding op has taken over the filters otherwise -> skip). */
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
