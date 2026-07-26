/**
 * "Publish to SpeleoDB" from the GlobalView recents context menu (#270).
 *
 * The in-project hamburger already offers this for the OPEN project
 * (useProjectMenuItems, id `publish-to-speleodb-menu`). From the home screen the
 * project is NOT open, and both halves of the feature are hard-wired to the open
 * one:
 *
 *   - the backend `speleodb_publish` acts on `AppState.project` and fails with
 *     "no project is open to publish" when nothing is open;
 *   - `PublishToSpeleoDbDialog` prefills its name / country / coordinates from
 *     `useProjectStore(s => s.project)` in `useState` initializers, i.e. it reads
 *     the open project ONCE, at mount.
 *
 * So the context-menu action must OPEN the project and let that load SETTLE
 * before the dialog is opened. Reversing the two would prefill the form from the
 * previously open project (or from nothing) and publish under the wrong name -
 * the ordering is the whole point of this module, and is pinned by
 * publishRecentToSpeleoDb.test.ts.
 *
 * Kept out of GlobalView.tsx so the ordering contract is unit-testable without
 * mounting the whole home screen (map included).
 */
import type { ProjectMetadata } from '../../types/project';

/** Injected seams: the store actions the flow drives (real ones in GlobalView). */
export interface PublishRecentDeps {
  /** `projectStore.loadProject` - resolves once the project is fully open. */
  loadProject: (path: string) => Promise<{ success: boolean }>;
  /** `uiStore.openDialog`. */
  openDialog: (dialog: string, data?: Record<string, unknown>) => void;
  /** Telemetry entry-point tag, applied before the open (`setProjectActionSource`). */
  markSource?: () => void;
}

/**
 * May this recent be published from the context menu?
 *
 * Gating mirrors the hamburger item (`!speleoLink && speleoSession?.loggedIn`),
 * translated to what a recents row knows synchronously:
 *   - a LOCAL project only: an entry that is already on SpeleoDB has nothing to
 *     publish, and the backend refuses a second publish anyway. `is_remote` is
 *     the recents-row equivalent of the open project's link; `speleodb_project_id`
 *     is checked too so a row that carries an id but a stale `is_remote:false`
 *     still counts as remote.
 *   - a signed-in session: publishing creates a server-side project, so a logged
 *     out user gets NO item rather than one that fails on click.
 *   - a single selection: publishing is per project (name, country, coordinates,
 *     collaborators are all one project's metadata), so it is hidden under a
 *     multi-selection instead of silently acting on just the right-clicked row.
 */
export function canPublishRecent(
  project: ProjectMetadata | null | undefined,
  loggedIn: boolean,
  selectedCount: number,
): boolean {
  if (!project) return false;
  if (!loggedIn) return false;
  if (selectedCount > 1) return false;
  if (project.is_remote) return false;
  if (project.speleodb_project_id) return false;
  return true;
}

/**
 * Open the project, THEN raise the publish dialog.
 *
 * Ordering (load settles first) is load-bearing - see the module doc. A failed
 * open opens no dialog: `loadProject` already surfaces its own failure (the
 * loading-error panel, or the permission / corruption dialogs it routes to), the
 * same way every other GlobalView open failure is surfaced, and publishing after
 * a failed open would publish whatever project was open before.
 *
 * @returns whether the dialog was opened.
 */
export async function publishRecentToSpeleoDb(
  path: string,
  deps: PublishRecentDeps,
): Promise<boolean> {
  deps.markSource?.();
  const result = await deps.loadProject(path);
  if (!result?.success) return false;
  deps.openDialog('publish-to-speleodb');
  return true;
}
