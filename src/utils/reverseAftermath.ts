/**
 * Frontend state that a section reverse invalidates (#24).
 *
 * The backend mirrors everything it owns: shots, the section anchor, and every
 * stored `StationKey` (merges, loop closures, zero datums, station offsets and
 * comments). What it cannot reach is the frontend's own POSITIONAL references -
 * `StationRef { section_id, station_index }` held in UI selection, the merge
 * tool's staging, the move-comment pickup, the distance-gradient origin and the
 * gas plan.
 *
 * Those are the dangerous kind of stale: a reverse renumbers station `i` to
 * `N - i`, so every one of them stays *in range* and simply starts naming a
 * different physical station. Nothing errors. The merge tool would merge the
 * wrong end; the distance ramp would silently re-root from the far end while
 * still looking correct; the gas plan would silently re-price a different route,
 * which is a number a diver acts on.
 *
 * Plan pins and the distance-gradient origin are mirrored (the user's plan and
 * their chosen root stay on the physical stations they picked); selection, merge
 * staging, the move-comment pickup and the comment popover are cleared, matching
 * what every other structural mutation does (ConfirmDialog, BulkDeleteDialog,
 * DeleteShotChoice).
 *
 * The same mirror has to run again whenever an undo or redo flips the numbering
 * BACK - otherwise Ctrl+Z restores the old numbering while the pins stay
 * mirrored onto the opposite physical stations, which then persists into the
 * saved plan. Mirroring is an involution, so re-applying it is the inverse; the
 * only question is which sections flipped, and `sectionsRenumberedByReverse`
 * answers that from the station geometry (see its note for why, rather than
 * from the undo history).
 */
import type { Coordinates, SectionId, Station, StationRef } from '../types/project';
import { useGasPlanStore } from '../store/gasPlanStore';
import { useUIStore } from '../store/uiStore';

/** Station `i` of a section with `shotCount` shots becomes station `shotCount - i`. */
export function mirrorRef(
  ref: StationRef,
  shotCounts: Map<SectionId, number>
): StationRef {
  const shotCount = shotCounts.get(ref.section_id);
  if (shotCount === undefined) return ref;
  // Clamped, not a bare subtraction: a plan pin outlives the shots it was
  // dropped on (its only reset is a project switch), so `station_index` can
  // already sit past the end of a shortened section - and `shotCount - index`
  // then goes NEGATIVE. `StationRef.station_index` is a `u32`, so serde rejects
  // the whole `compute_gas_reach_field` payload and the reach overlay fails
  // permanently on one poisoned pin rather than degrading. The backend's
  // import-side mirror clamps for the same reason. An already-broken pin lands
  // on an end station instead of a negative index; it was not naming a real
  // station either way, and the clamp keeps every other pin working.
  const mirrored = shotCount - ref.station_index;
  if (mirrored < 0) return { ...ref, station_index: 0 };
  if (mirrored > shotCount) return { ...ref, station_index: shotCount };
  return { ...ref, station_index: mirrored };
}

function mirrorNullable(
  ref: StationRef | null,
  shotCounts: Map<SectionId, number>
): StationRef | null {
  return ref === null ? null : mirrorRef(ref, shotCounts);
}

/** The pieces of the gas plan that are keyed by station position. */
export interface PlanPins {
  origin: StationRef | null;
  endpoint: StationRef | null;
  waypoints: StationRef[];
  markedPoints: { station: StationRef; label: string | null }[];
  stageDropOverrides: (StationRef | null)[];
}

/**
 * Rewrite every plan pin that sits in a reversed section onto its mirrored
 * station. Pins in other sections are returned untouched (by identity where
 * possible, so an unaffected plan produces no spurious state change).
 */
export function mirrorPlanPins(
  pins: PlanPins,
  shotCounts: Map<SectionId, number>
): PlanPins {
  return {
    origin: mirrorNullable(pins.origin, shotCounts),
    endpoint: mirrorNullable(pins.endpoint, shotCounts),
    waypoints: pins.waypoints.map((w) => mirrorRef(w, shotCounts)),
    markedPoints: pins.markedPoints.map((m) => ({
      ...m,
      station: mirrorRef(m.station, shotCounts),
    })),
    stageDropOverrides: pins.stageDropOverrides.map((s) => mirrorNullable(s, shotCounts)),
  };
}

/** True when any pin sits in one of the reversed sections. */
export function planPinsAffected(
  pins: PlanPins,
  shotCounts: Map<SectionId, number>
): boolean {
  const inReversed = (ref: StationRef | null) =>
    ref !== null && shotCounts.has(ref.section_id);
  return (
    inReversed(pins.origin) ||
    inReversed(pins.endpoint) ||
    pins.waypoints.some((w) => inReversed(w)) ||
    pins.markedPoints.some((m) => inReversed(m.station)) ||
    pins.stageDropOverrides.some((s) => inReversed(s))
  );
}

/** One section's station world positions, indexed by station index. */
export type SectionStationPositions = Map<SectionId, (Coordinates | undefined)[]>;

/**
 * Snapshot the world position of every station belonging to `sectionIds`.
 *
 * Scoped to the sections that actually hold a positional ref, so a project with
 * no plan and no picked distance origin pays nothing on undo/redo.
 */
export function captureStationPositions(
  stations: readonly Station[],
  sectionIds: ReadonlySet<SectionId>
): SectionStationPositions {
  const out: SectionStationPositions = new Map();
  if (sectionIds.size === 0) return out;
  for (const station of stations) {
    const { section_id, station_index } = station.station_ref;
    if (!sectionIds.has(section_id)) continue;
    let row = out.get(section_id);
    if (row === undefined) {
      row = [];
      out.set(section_id, row);
    }
    row[station_index] = station.coordinates;
  }
  return out;
}

/**
 * Two station positions count as the same place below this (metres). A reverse
 * re-walks the chain from the other end with reciprocated bearings, so the
 * coordinates come back equal only to a few ulps, never bit-exact.
 */
const SAME_POINT_EPSILON_M = 1e-6;

function samePoint(a: Coordinates | undefined, b: Coordinates | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    Math.abs(a.x - b.x) < SAME_POINT_EPSILON_M &&
    Math.abs(a.y - b.y) < SAME_POINT_EPSILON_M &&
    Math.abs(a.z - b.z) < SAME_POINT_EPSILON_M
  );
}

/**
 * Sections whose numbering flipped end-to-end between two station snapshots,
 * mapped to their shot count - i.e. exactly the `shotCounts` the mirrors above
 * take.
 *
 * Read off the geometry rather than the undo entry on purpose. A reverse keeps
 * every station's world coordinate and only renumbers, so "station `i` now sits
 * where station `N - i` used to" IS the property the pins have to follow,
 * whatever produced it - a plain undo, a redo, one entry of a multi-section
 * batch, or an `undo_to` that walks past several. `CommandResult` carries no
 * section ids for undo/redo, and the history entry would only offer the
 * command's human-readable description to parse, which would then break
 * silently the next time that string is reworded.
 *
 * A section whose positions are unchanged station-for-station is reported as NOT
 * flipped even when it also mirror-matches. That is the palindrome case (a
 * section that folds back exactly on itself): mirroring there would move a pin
 * to a station sitting at the identical coordinate, so skipping it costs
 * nothing and avoids a spurious state change on every unrelated undo.
 */
export function sectionsRenumberedByReverse(
  before: SectionStationPositions,
  after: SectionStationPositions
): Map<SectionId, number> {
  const flipped = new Map<SectionId, number>();
  for (const [sectionId, was] of before) {
    const now = after.get(sectionId);
    // A changed station count means the section itself changed (a deleted shot
    // came back, the section was removed) - that is not a renumbering.
    if (now === undefined || now.length !== was.length || was.length < 2) continue;
    let mirrors = true;
    let identical = true;
    for (let i = 0; i < was.length && (mirrors || identical); i++) {
      if (!samePoint(now[i], was[was.length - 1 - i])) mirrors = false;
      if (!samePoint(now[i], was[i])) identical = false;
    }
    if (mirrors && !identical) flipped.set(sectionId, was.length - 1);
  }
  return flipped;
}

/**
 * Every section a frontend-held positional ref currently points into: the gas
 * plan's pins plus the distance-gradient origin. The set undo/redo has to watch
 * for a renumbering.
 */
export function sectionsWithPositionalRefs(): Set<SectionId> {
  const out = new Set<SectionId>();
  const add = (ref: StationRef | null) => {
    if (ref !== null) out.add(ref.section_id);
  };
  const plan = useGasPlanStore.getState();
  add(plan.origin);
  add(plan.endpoint);
  for (const w of plan.waypoints) add(w);
  for (const m of plan.markedPoints) add(m.station);
  for (const s of plan.stageDropOverrides) add(s);
  add(useUIStore.getState().distanceGradientOrigin);
  return out;
}

/**
 * Re-point (or drop) every frontend-held positional ref after the sections in
 * `shotCounts` were renumbered end-to-end.
 *
 * Shared by the Reverse dialog and by undo/redo, so the forward action and the
 * flip back cannot drift apart - the mirror is an involution, so running this
 * again with the same shot counts undoes it exactly. (An already out-of-range
 * ref is the one exception: it gets clamped rather than round-tripped, which is
 * what `mirrorRef` is for.)
 */
export function applyReverseAftermath(shotCounts: Map<SectionId, number>): void {
  if (shotCounts.size === 0) return;

  const plan = useGasPlanStore.getState();
  if (planPinsAffected(plan, shotCounts)) {
    // Mirrored, not cleared: the diver picked these stations, and the point of a
    // reverse is that the physical cave did not move.
    plan.applyReversedPins(mirrorPlanPins(plan, shotCounts));
  }

  const ui = useUIStore.getState();
  const origin = ui.distanceGradientOrigin;
  if (origin !== null && shotCounts.has(origin.section_id)) {
    // Same reasoning as the plan pins: the penetration ramp is rooted on a
    // station the user chose, and its only other reset is a project switch, so
    // without this the ramp silently re-roots from the opposite end of the
    // section while the origin ring and the DetailPanel badge agree with it.
    ui.setDistanceGradientOrigin(mirrorRef(origin, shotCounts));
  }

  // Cleared instead - there is no "same place" for a highlight, and a
  // half-staged merge (or a picked-up comment) that silently retargets the far
  // end is worse than one the user has to restart.
  ui.clearSelection();
  ui.clearMergeStations();
  ui.clearMoveCommentSource();
  ui.clearCommentTarget();
}
