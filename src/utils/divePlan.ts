import type { Cylinder, Diver, DivePlanSnapshot, GasConfig } from '../types/ipc.generated';
import type { StationRef } from '../types/project';

/**
 * Dive-plan snapshot helpers (#244). A saved plan captures exactly the six gas
 * inputs that `compute_gas_reach_field` takes; loading one is "set the inputs and
 * recompute". These helpers build the persisted (snake_case IPC) snapshot from the
 * live store fields and compare two snapshots for dirty-tracking.
 * See `docs/plans/2026-07-06_dive-plan-persistence.md`.
 */

/** The six gas inputs a dive plan captures (the store's camelCase view). */
export interface DivePlanInputs {
  origin: StationRef | null;
  endpoint: StationRef | null;
  diver: Diver;
  cylinders: Cylinder[];
  gasConfig: GasConfig;
  stageDropOverrides: (StationRef | null)[];
}

/** Build the persisted snapshot (snake_case IPC shape) from the live store inputs. */
export function divePlanSnapshotOf(i: DivePlanInputs): DivePlanSnapshot {
  return {
    origin: i.origin,
    endpoint: i.endpoint,
    diver: i.diver,
    cylinders: i.cylinders,
    gas_config: i.gasConfig,
    stage_drop_overrides: i.stageDropOverrides,
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
