import { invokeIpc } from './ipc';
import type { SpeleoLocalProjectState } from '../types/ipc.generated';

/**
 * "This work exists only on this computer" - the local half of the SpeleoDB
 * picture (#270).
 *
 * `has_unpushed_edits` is NOT `projectStore.isDirty`: it means "edits that are not
 * on the SpeleoDB server", it survives a save and a restart, and it is true for a
 * project nobody currently has open. The server-derived scans (the held-lock scan,
 * the GlobalView remote list) cannot see it, so the frontend joins it in from
 * `speleodb_local_project_states`.
 */
export type SpeleoLocalStateMap = Record<string, SpeleoLocalProjectState>;

/**
 * The accent colour for "there are changes here that SpeleoDB does not have".
 *
 * This is the SAME token the toolbar's Import icon uses (`--sh-comment`, the
 * syntactic-highlighting comment/amber role - see Toolbar.tsx and index.css), so the
 * app has one yellow for "attention, but nothing is broken" rather than a second
 * hand-picked shade. Referenced as a CSS var (not a Tailwind class) because the
 * SpeleoDB mark is a raster PNG tinted via a mask, which needs a real colour value.
 */
export const UNPUSHED_ACCENT = 'var(--sh-comment)';

/**
 * Per-project local state for `projectIds`, keyed by project id. Purely local (no
 * token, no network): the backend walks the pull cache read-only and degrades a
 * bad file to a "nothing here" row rather than failing the call.
 *
 * Throws only if the IPC itself fails; callers must treat that as "unknown", never
 * as "no local edits".
 */
export async function fetchSpeleoLocalStates(projectIds: string[]): Promise<SpeleoLocalStateMap> {
  if (projectIds.length === 0) return {};
  const reply = await invokeIpc<SpeleoLocalStateMap | null>(
    'speleodb_local_project_states',
    { projectIds },
    { purpose: 'find which projects have changes only on this computer' },
  );
  // A mocked/older backend can answer `null`; treat it as "nothing known".
  return reply ?? {};
}

/** Whether `states` positively reports un-pushed local edits for `projectId`. */
export function hasUnpushedEdits(
  states: SpeleoLocalStateMap,
  projectId: string | null | undefined,
): boolean {
  if (!projectId) return false;
  return states[projectId]?.has_unpushed_edits === true;
}
