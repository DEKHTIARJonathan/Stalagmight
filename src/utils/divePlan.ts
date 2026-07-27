import type {
  Cylinder,
  Diver,
  DivePlanSnapshot,
  GasConfig,
  MarkedPoint,
} from '../types/ipc.generated';
import type { StationRef } from '../types/project';

/**
 * Dive-plan snapshot helpers (#244). A saved plan captures exactly the gas inputs
 * that `compute_gas_reach_field` takes, plus the plan-only marked points (#298);
 * loading one is "set the inputs and recompute". These helpers build the persisted
 * (snake_case IPC) snapshot from the live store fields and compare two snapshots for
 * dirty-tracking - so anything added here is dirty-tracked and close-guarded for free.
 * See `git show de8eef91:docs/plans/2026-07-06_dive-plan-persistence.md` (doc removed from master in #229).
 */

/** The plan inputs a dive plan captures (the store's camelCase view). */
export interface DivePlanInputs {
  origin: StationRef | null;
  endpoint: StationRef | null;
  waypoints: StationRef[];
  diver: Diver;
  cylinders: Cylinder[];
  gasConfig: GasConfig;
  stageDropOverrides: (StationRef | null)[];
  markedPoints: MarkedPoint[];
}

/** Build the persisted snapshot (snake_case IPC shape) from the live store inputs. */
export function divePlanSnapshotOf(i: DivePlanInputs): DivePlanSnapshot {
  return {
    origin: i.origin,
    endpoint: i.endpoint,
    waypoints: i.waypoints,
    diver: i.diver,
    cylinders: i.cylinders,
    gas_config: i.gasConfig,
    stage_drop_overrides: i.stageDropOverrides,
    // Trim marked-point labels HERE, not in the store setter: the setter runs per keystroke against
    // a controlled input, where normalising would eat the space the user just typed. This is the
    // boundary that actually cares - surrounding padding would otherwise count against the backend's
    // label cap for no visible benefit, and an all-whitespace label round-trips as "no label"
    // rather than a blank string.
    //
    // It also has to be the dirty-tracking basis, and it is: `selectIsPlanDirty` diffs this same
    // snapshot against the baseline, so typing a trailing space does not leave a plan permanently
    // dirty against a value the save would have normalised away.
    marked_points: i.markedPoints.map((m) => {
      const trimmed = m.label?.trim();
      return { ...m, label: trimmed ? trimmed : null };
    }),
  };
}

/**
 * Order-independent structural deep-equality for JSON-like plan data. Kept local
 * (no lodash / fast-deep-equal in the tree) and scoped to the plain serde values a
 * snapshot holds (objects, arrays, primitives, null) - not a general-purpose deep
 * equal (no Map/Set/Date handling needed here).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    return a.every((v, idx) => deepEqual(v, (b as unknown[])[idx]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k])
  );
}

/** Whether two plan snapshots represent the same plan inputs. */
export function divePlanSnapshotsEqual(a: DivePlanSnapshot, b: DivePlanSnapshot): boolean {
  return deepEqual(a, b);
}
