/**
 * Open a recents entry (map, list/table, keyboard shortcut - #450, #470).
 *
 * Two responsibilities, in order:
 *  1. Attribute the open for telemetry BEFORE routing, so a route that hands
 *     off to a dialog (unsaved-changes, swap-confirm, SpeleoDB hand-back)
 *     still completes under the right source.
 *  2. Route through the shared open/import router with `allow: 'project-only'`
 *     (#450 security fix): a recents entry is read from persisted config - a
 *     hand-edited or legacy entry could carry any extension - so this must
 *     refuse anything but `.stalx` rather than let it reach the import
 *     parsers, mirroring the OS-launch route's `LAUNCHABLE_EXTENSIONS`
 *     allowlist (launch.rs).
 *
 * Kept out of GlobalView.tsx so the attribution-then-gate ordering is
 * unit-testable without mounting the whole home screen (map included) -
 * mirrors publishRecentToSpeleoDb.ts.
 */
import { routeOpenedFile } from '../../utils/openOrImport';
import { setProjectActionSource, type SourceName } from '../../utils/telemetry';

export async function openRecentEntry(
  filePath: string,
  source: SourceName,
): Promise<void> {
  setProjectActionSource(source);
  await routeOpenedFile(filePath, 'Open Failed', { allow: 'project-only' });
}
