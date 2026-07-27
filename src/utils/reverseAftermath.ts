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
 * saved plan. The backend answers "which sections, against which shot count"
 * outright on `CommandResult.reversed_sections`, because the geometry cannot: a
 * reverse keeps every world coordinate, so a section that was reversed AND moved
 * in one action matches neither arrangement afterwards.
 *
 * Those entries are COMPOSED into one affine map per section and applied once
 * (see `composeReverseTransforms`), never replayed per entry. The mirror is not
 * an involution - it CLAMPS - and a multi-step `undo_to` can walk past a
 * `CreateShot`, so the count differs between steps; either fact on its own
 * breaks a per-entry fold.
 */
import type { Section, SectionId, StationRef } from '../types/project';
import type { ReversedSection } from '../types/ipc/ReversedSection';
import { useGasPlanStore } from '../store/gasPlanStore';
import { useUIStore } from '../store/uiStore';

/**
 * The NET renumbering one section came out of an operation with, as the affine
 * map `i -> shift + sign * i` over station indices.
 *
 * One reverse of an `N`-shot section is `{ shift: N, sign: -1 }`; composing two
 * with counts `c1` then `c2` gives `{ shift: c2 - c1, sign: +1 }`, which is the
 * IDENTITY exactly when the counts match. That is the whole reason for carrying a
 * transform rather than a divisor: `i -> N - i` applied twice is only the
 * identity when nothing changed the count in between, and only for an in-range
 * index (see `applyTransform`'s clamp).
 */
export interface ReverseTransform {
  /** `A` in `i -> A + s * i`. */
  shift: number;
  /** `s` in `i -> A + s * i`: `-1` after an odd number of reverses, `+1` after an even one. */
  sign: 1 | -1;
  /** Highest valid station index in the section as it stands NOW (== its shot count). */
  maxIndex: number;
}

/**
 * The transform ONE reverse of a section with `shotCount` shots applies:
 * station `i` becomes station `shotCount - i`.
 *
 * This is what the Reverse dialog's forward path installs. It knows the sections
 * it submitted and their counts outright, so it never has to compose anything.
 */
export function singleReverseTransform(shotCount: number): ReverseTransform {
  return { shift: shotCount, sign: -1, maxIndex: shotCount };
}

/** True when the composed transform is `i -> i`: the numbering ended where it started. */
export function isIdentityTransform(transform: ReverseTransform): boolean {
  return transform.sign === 1 && transform.shift === 0;
}

/** True when `transforms` actually renumbered `sectionId`; an identity entry did not. */
function flipsSection(
  transforms: Map<SectionId, ReverseTransform>,
  sectionId: SectionId
): boolean {
  const transform = transforms.get(sectionId);
  return transform !== undefined && !isIdentityTransform(transform);
}

/**
 * Apply a composed transform to one index, clamping ONCE at the end.
 *
 * Clamped, not a bare affine map: a plan pin outlives the shots it was dropped
 * on (its only reset is a project switch), so `station_index` can already sit
 * past the end of a shortened section - and `shotCount - index` then goes
 * NEGATIVE. `StationRef.station_index` is a `u32`, so serde rejects the whole
 * `compute_gas_reach_field` payload and the reach overlay fails permanently on
 * one poisoned pin rather than degrading. The backend's import-side mirror clamps
 * for the same reason. An already-broken pin lands on an end station instead of a
 * negative index; it was not naming a real station either way, and the clamp
 * keeps every other pin working.
 *
 * ONCE is load-bearing: clamping per step would send an out-of-range pin
 * `p -> 0 -> shotCount` across two reverses that between them changed nothing.
 * Composing first and clamping at the end keeps a net no-op a no-op.
 */
export function applyTransform(ref: StationRef, transform: ReverseTransform): StationRef {
  const moved = transform.shift + transform.sign * ref.station_index;
  if (moved < 0) return { ...ref, station_index: 0 };
  if (moved > transform.maxIndex) return { ...ref, station_index: transform.maxIndex };
  return { ...ref, station_index: moved };
}

/** Re-point `ref` by whatever its section's numbering ended up doing. */
export function mirrorRef(
  ref: StationRef,
  transforms: Map<SectionId, ReverseTransform>
): StationRef {
  const transform = transforms.get(ref.section_id);
  // An identity entry is a section whose numbering ended exactly where it
  // started. Returning `ref` itself rather than running the clamp keeps that a
  // TOTAL no-op: `applyTransform` would still pull an already out-of-range pin
  // down to `maxIndex`, which is a silent move nothing asked for.
  if (transform === undefined || isIdentityTransform(transform)) return ref;
  return applyTransform(ref, transform);
}

function mirrorNullable(
  ref: StationRef | null,
  transforms: Map<SectionId, ReverseTransform>
): StationRef | null {
  return ref === null ? null : mirrorRef(ref, transforms);
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
 * Rewrite every plan pin that sits in a renumbered section onto its mirrored
 * station. Pins in other sections are returned untouched (by identity where
 * possible, so an unaffected plan produces no spurious state change).
 */
export function mirrorPlanPins(
  pins: PlanPins,
  transforms: Map<SectionId, ReverseTransform>
): PlanPins {
  return {
    origin: mirrorNullable(pins.origin, transforms),
    endpoint: mirrorNullable(pins.endpoint, transforms),
    waypoints: pins.waypoints.map((w) => mirrorRef(w, transforms)),
    markedPoints: pins.markedPoints.map((m) => ({
      ...m,
      station: mirrorRef(m.station, transforms),
    })),
    stageDropOverrides: pins.stageDropOverrides.map((s) => mirrorNullable(s, transforms)),
  };
}

/** True when any pin sits in a section this operation actually renumbered. */
export function planPinsAffected(
  pins: PlanPins,
  transforms: Map<SectionId, ReverseTransform>
): boolean {
  const inReversed = (ref: StationRef | null) =>
    ref !== null && flipsSection(transforms, ref.section_id);
  return (
    inReversed(pins.origin) ||
    inReversed(pins.endpoint) ||
    pins.waypoints.some((w) => inReversed(w)) ||
    pins.markedPoints.some((m) => inReversed(m.station)) ||
    pins.stageDropOverrides.some((s) => inReversed(s))
  );
}

/**
 * Compose a `CommandResult.reversed_sections` log into one transform per section.
 *
 * Taken from the backend rather than inferred from the geometry: a reverse keeps
 * every station's world position, so a section that was reversed AND moved in
 * the same action matches NEITHER arrangement afterwards and a position diff
 * reports nothing for it, leaving its pins on the opposite end.
 *
 * The entries arrive in step order and WITH REPEATS, each carrying the shot count
 * in force AT ITS STEP. `m_c(i) = c - i`, so over counts `c1..ck` the composition
 * is `i -> A + s*i` with `s = (-1)^k` and `A_m = c_m - A_(m-1)` (`A_0 = 0`). Two
 * equal counts collapse to the exact identity; two different ones (a `CreateShot`
 * undone between two reverses of the same section) leave a pure shift, which is
 * the answer neither "cancel the repeat" nor "replay the mirror twice" can give.
 *
 * `sections` is the project state AFTER the operation, and supplies `maxIndex`:
 * the numbering the pins now have to fit. A section the refreshed project no
 * longer has is dropped - there is nothing left to mirror into - and so is a
 * shot-less one, which is a single station with no other end (mirroring it would
 * only churn the UI state `applyReverseAftermath` clears).
 */
export function composeReverseTransforms(
  entries: readonly ReversedSection[] | undefined,
  sections: readonly Pick<Section, 'id' | 'shots'>[]
): Map<SectionId, ReverseTransform> {
  const out = new Map<SectionId, ReverseTransform>();
  if (entries === undefined || entries.length === 0) return out;

  const composed = new Map<SectionId, { shift: number; sign: 1 | -1 }>();
  for (const entry of entries) {
    const soFar = composed.get(entry.section_id) ?? { shift: 0, sign: 1 as const };
    composed.set(entry.section_id, {
      shift: entry.shot_count - soFar.shift,
      sign: soFar.sign === 1 ? -1 : 1,
    });
  }

  for (const section of sections) {
    const transform = composed.get(section.id);
    if (transform === undefined || section.shots.length === 0) continue;
    out.set(section.id, { ...transform, maxIndex: section.shots.length });
  }
  return out;
}

/**
 * Re-point (or drop) every frontend-held positional ref after the sections in
 * `transforms` were renumbered.
 *
 * Shared by the Reverse dialog (which builds its own `singleReverseTransform`
 * map from the sections it submitted) and by undo/redo (which composes the
 * backend's per-step log), so the forward action and the flip back cannot drift
 * apart.
 *
 * An all-identity map returns immediately instead of running an identity mirror.
 * That is not an optimisation: the four clears below are destructive, and a range
 * of reverses that cancelled out renumbered nothing, so the user's selection and
 * half-staged merge are still valid.
 */
export function applyReverseAftermath(transforms: Map<SectionId, ReverseTransform>): void {
  if (Array.from(transforms.values()).every(isIdentityTransform)) return;

  const plan = useGasPlanStore.getState();
  if (planPinsAffected(plan, transforms)) {
    // Mirrored, not cleared: the diver picked these stations, and the point of a
    // reverse is that the physical cave did not move.
    plan.applyReversedPins(mirrorPlanPins(plan, transforms));
  }

  const ui = useUIStore.getState();
  const origin = ui.distanceGradientOrigin;
  if (origin !== null && flipsSection(transforms, origin.section_id)) {
    // Same reasoning as the plan pins: the penetration ramp is rooted on a
    // station the user chose, and its only other reset is a project switch, so
    // without this the ramp silently re-roots from the opposite end of the
    // section while the origin ring and the DetailPanel badge agree with it.
    ui.setDistanceGradientOrigin(mirrorRef(origin, transforms));
  }

  // Cleared instead - there is no "same place" for a highlight, and a
  // half-staged merge (or a picked-up comment) that silently retargets the far
  // end is worse than one the user has to restart.
  ui.clearSelection();
  ui.clearMergeStations();
  ui.clearMoveCommentSource();
  ui.clearCommentTarget();
}
