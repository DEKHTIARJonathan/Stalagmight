/**
 * Shared file/project shortcut actions: New / Open / Import DMP / Quit.
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
import { useProjectStore } from '../store/projectStore';
import { isEditingBlockedNow } from '../hooks/useEditingBlocked';
import { pickAndRoute } from './openOrImport';
import { newProjectGuarded } from './projectActions';
import { quitApp } from './quit';
import { setProjectActionSource } from './telemetry';
import { projectOpenFilters, importFiltersForContext } from './fileDialogs';

export type FileShortcutAction = 'new_file' | 'open_file' | 'import_dmp' | 'quit';

/**
 * Run one shared file action. Caller has already `preventDefault()`-ed the event
 * and (for telemetry on the toast path) may show a toast afterwards.
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
      void pickAndRoute(projectOpenFilters(), 'Open Failed');
      break;
    case 'import_dmp': {
      const hasProject = !!useProjectStore.getState().project;
      // The read-only map (#70 closure-adjusted view, #243 Plan/Export, or a
      // locked remote SpeleoDB project) rejects imports - they add sections. Skip
      // even opening the picker (routeOpenedFile also guards). Only meaningful
      // with a project open; GlobalView has none.
      if (hasProject && isEditingBlockedNow()) return;
      setProjectActionSource('keyboard');
      // With a project open the picker is scoped to DMP only (the sole additive
      // in-project import); with none, every importable format is offered plus a
      // native .stalx open. pickAndRoute dispatches by extension.
      void pickAndRoute(importFiltersForContext(hasProject), 'Import Failed');
      break;
    }
    case 'quit':
      quitApp();
      break;
  }
}
