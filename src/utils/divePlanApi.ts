import { invokeIpc } from './ipc';
import type { DivePlan, DivePlanMeta, DivePlanSnapshot } from '../types/ipc.generated';

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
