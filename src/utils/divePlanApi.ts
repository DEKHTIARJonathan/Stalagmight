import { invokeIpc } from './ipc';
import type { Cylinder, Diver, DivePlan, DivePlanMeta, DivePlanSnapshot, GasConfig, StationRef } from '../types/ipc.generated';

/**
 * The plan inputs the profile export takes - the same tuple `compute_gas_reach_field` takes.
 *
 * The backend recomputes the reach field from these rather than accepting the one the UI is
 * holding: an exported profile is a document the diver may act on later, so it has to be what the
 * engine says now. Every plan edit nulls the cached field, so a client-supplied one could easily be
 * a route the diver has already changed.
 */
export interface DiveProfileRequest {
  origin: StationRef | null;
  endpoint: StationRef | null;
  waypoints: StationRef[];
  diver: Diver;
  cylinders: Cylinder[];
  gas_config: GasConfig;
  stage_drop_overrides: (StationRef | null)[];
}

/** Wire values the backend's `ProfileFormat::from_wire` accepts. */
export type DiveProfileFormat = 'subsurface-xml' | 'text';

/** Write the planned dive profile to `path`. Rejects when the plan has no route. */
export function exportDiveProfile(
  path: string,
  format: DiveProfileFormat,
  request: DiveProfileRequest
): Promise<void> {
  return invokeIpc<void>(
    'export_dive_profile',
    { path, format, request },
    { purpose: 'export the planned dive profile', fields: { format } }
  );
}

/** Render the profile as text without writing it, for the clipboard. */
export function renderDiveProfileText(request: DiveProfileRequest): Promise<string> {
  return invokeIpc<string>(
    'render_dive_profile_text',
    { request },
    { purpose: 'copy the planned dive profile' }
  );
}

/**
 * Typed wrappers for the dive-plan (`.plnx`) IPC commands (#244). The backend
 * reads/writes a SQLite sibling next to the open project; these calls return `[]`
 * / a friendly error when there is no saved project. See `divePlan.ts` for the
 * snapshot shape and `git show de8eef91:docs/plans/2026-07-06_dive-plan-persistence.md` (doc removed from master in #229).
 */

/** List the saved plans for the open project (newest first; `[]` if none). */
export function listDivePlans(): Promise<DivePlanMeta[]> {
  return invokeIpc<DivePlanMeta[]>('list_dive_plans', {}, { purpose: 'list dive plans' });
}

/** Load one plan; the backend nulls any station refs that no longer resolve and
 *  reports how many via `stale_ref_count`. */
export function loadDivePlan(id: number): Promise<DivePlan> {
  return invokeIpc<DivePlan>(
    'load_dive_plan',
    { id },
    { purpose: 'load dive plan', fields: { id } }
  );
}

/** Save a plan: `id = null` inserts (Save as), a number overwrites (Save). */
export function saveDivePlan(
  id: number | null,
  name: string,
  snapshot: DivePlanSnapshot
): Promise<DivePlanMeta> {
  return invokeIpc<DivePlanMeta>(
    'save_dive_plan',
    { id, name, snapshot },
    { purpose: 'save dive plan', fields: { id: id ?? 'new' } }
  );
}

/** Delete a plan by id. */
export function deleteDivePlan(id: number): Promise<void> {
  return invokeIpc<void>(
    'delete_dive_plan',
    { id },
    { purpose: 'delete dive plan', fields: { id } }
  );
}
