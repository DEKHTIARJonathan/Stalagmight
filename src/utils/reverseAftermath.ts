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
 * only question is which sections flipped, and the backend answers that
 * outright - `CommandResult.reversed_section_ids` names them on the forward
 * command AND on the undo/redo of one (see `netReversedShotCounts`).
 */
import type { Section, SectionId, StationRef } from '../types/project';
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

/**
 * The sections a `CommandResult.reversed_section_ids` renumbered, mapped to
 * their shot count - i.e. exactly the `shotCounts` the mirrors above take.
 *
 * Taken from the backend rather than inferred from the geometry: a reverse keeps
 * every station's world position, so a section that was reversed AND moved in
 * the same action matches NEITHER arrangement afterwards and a position diff
 * reports nothing for it, leaving its pins on the opposite end.
 *
 * The ids arrive in command order and WITH REPEATS - a batch that reverses the
 * same section twice lists it twice. Mirroring is an involution, so the mirror
 * is applied once per entry: an even number of entries for one section is a net
 * no-op, an odd number is a single mirror.
 *
 * `sections` is the project state AFTER the operation. A reverse only renumbers -
 * `Project::reverse_section` reverses the shot vector in place and never adds or
 * removes one - so the count is the same before and after, and reading it after
 * keeps it consistent with everything else the same batch (or undone entry) did.
 * A section the refreshed project no longer has is dropped: there is nothing
 * left to mirror into.
 */
export function netReversedShotCounts(
  reversedSectionIds: readonly SectionId[] | undefined,
  sections: readonly Pick<Section, 'id' | 'shots'>[]
): Map<SectionId, number> {
  const out = new Map<SectionId, number>();
  if (reversedSectionIds === undefined || reversedSectionIds.length === 0) return out;
  const netFlipped = new Set<SectionId>();
  for (const id of reversedSectionIds) {
    // Toggle: the second listing of a section cancels the first.
    if (!netFlipped.delete(id)) netFlipped.add(id);
  }
  for (const section of sections) {
    // A shot-less section is a single station and reverses to itself, so the
    // backend lists it while nothing actually moved. Skipping it keeps
    // `applyReverseAftermath` from clearing the user's selection for nothing.
    if (netFlipped.has(section.id) && section.shots.length > 0) {
      out.set(section.id, section.shots.length);
    }
  }
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
