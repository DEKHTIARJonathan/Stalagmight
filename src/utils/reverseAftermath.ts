/**
 * Frontend state that a section reverse invalidates (#24).
 *
 * The backend mirrors everything it owns: shots, the section anchor, and every
 * stored `StationKey` (merges, loop closures, zero datums, station offsets and
 * comments). What it cannot reach is the frontend's own POSITIONAL references -
 * `StationRef { section_id, station_index }` held in UI selection, the merge
 * tool's staging and the gas plan.
 *
 * Those are the dangerous kind of stale: a reverse renumbers station `i` to
 * `N - i`, so every one of them stays *in range* and simply starts naming a
 * different physical station. Nothing errors. The merge tool would merge the
 * wrong end; the gas plan would silently re-price a different route, which is a
 * number a diver acts on.
 *
 * Plan pins are mirrored (the user's plan stays on the physical stations they
 * picked); selection and merge staging are cleared, matching what every other
 * structural mutation does (ConfirmDialog, BulkDeleteDialog, DeleteShotChoice).
 */
import type { SectionId, StationRef } from '../types/project';

/** Station `i` of a section with `shotCount` shots becomes station `shotCount - i`. */
export function mirrorRef(
  ref: StationRef,
  shotCounts: Map<SectionId, number>
): StationRef {
  const shotCount = shotCounts.get(ref.section_id);
  if (shotCount === undefined) return ref;
  return { ...ref, station_index: shotCount - ref.station_index };
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
