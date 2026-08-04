/**
 * Shared file/project shortcut actions: New / Open / Import / Quit.
 *
 * GlobalView and SingleSystemView each register their own keyboard dispatcher,
 * but both expose this same set of file actions. Routing them through one helper
 * keeps the unsaved-changes guard, the entry-point source tag, the read-only
 * import guard, and the picker filters in a single place - so the two views can't
 * drift (e.g. the `quit` action previously had to be added to both dispatchers
 * independently, and the New-project unsaved-changes guard existed in the menu
 * path but not the keyboard path).
 *
 * Stores are read via `getState()` so this is callable from raw keydown handlers
 * (outside React), like the rest of the open/import routing.
 */
import { pickAndRoute } from './openOrImport';
import { newProjectGuarded } from './projectActions';
import { quitApp } from './quit';
import { setProjectActionSource } from './telemetry';
import { openOrImportFilters } from './fileDialogs';

export type FileShortcutAction = 'new_file' | 'open_file' | 'import_dmp' | 'quit';

/**
 * Run one shared file action. Caller has already `preventDefault()`-ed the event
 * and (for telemetry on the toast path) may show a toast afterwards.
 *
 * One door (#407): Ctrl+O and Ctrl+I open the SAME unified picker (every file
 * the app can open or import) and route through the shared open/import router -
 * the two bindings survive because users reach for either word, but the
 * behavior is one (only the error-dialog title differs). The old Ctrl+I
 * pre-guard (skip the picker entirely while editing is blocked) is gone on
 * purpose: it silently swallowed the keystroke, and it wrongly blocked the
 * now-legal non-mutating routes (.stalx open, import-as-new-project). The
 * additive DMP-into-open-project case is still rejected - by routeOpenedFile's
 * read-only guard, which explains WHICH read-only cause to fix.
 */
export function runFileShortcutAction(action: FileShortcutAction): void {
  switch (action) {
    case 'new_file':
      setProjectActionSource('keyboard');
      // Shared with the menu "New" path: the dirty-project unsaved-changes guard
      // lives in newProjectGuarded so the two can't drift.
      newProjectGuarded();
      break;
    case 'open_file':
      setProjectActionSource('keyboard');
      void pickAndRoute(openOrImportFilters(), 'Open Failed');
      break;
    case 'import_dmp':
      setProjectActionSource('keyboard');
      void pickAndRoute(openOrImportFilters(), 'Import Failed');
      break;
    case 'quit':
      quitApp();
      break;
  }
}
