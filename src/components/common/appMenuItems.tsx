/**
 * Shared AppMenu rows used by BOTH the GlobalView hamburger and the in-project
 * hamburger (useProjectMenuItems), so the common New / Open / Settings / Debug /
 * Quit entries are defined exactly once instead of being hand-maintained twice
 * (they had already drifted — e.g. the quit handler). Item ids match the
 * legacy/e2e selectors so existing tests keep working.
 */
import type { TFunction } from 'i18next';
import {
  FilePlusIcon,
  FolderOpenIcon,
  SettingsIcon,
  BugIcon,
  QuitIcon,
} from './icons';
import { MENU_ICON_COLORS } from './menuColors';
import { setProjectActionSource, type SourceName } from '../../utils/telemetry';
import { quitApp } from '../../utils/quit';
import { pickAndRoute } from '../../utils/openOrImport';
import type { AppMenuItem } from './AppMenu';

const ICON_SIZE = 18;

/** Filters passed to the file picker — `[{ name, extensions }]`. */
type FileFilters = Array<{ name: string; extensions: string[] }>;

/**
 * Tag the entry-point `source` then route the picked file through the shared
 * open/import router (so it shares the closure-adjusted read-only guard and
 * per-extension dispatch with the toolbar / Ctrl+I / drag-drop paths). Shared by
 * the import menu rows and the GlobalView EmptyState card so the set-source-then-
 * route body lives in exactly one place.
 */
export function runImport(filters: FileFilters, source: SourceName): void {
  setProjectActionSource(source);
  void pickAndRoute(filters, 'Import Failed');
}

/**
 * A single "import <format>" row: tags the entry-point `source` then routes the
 * picked file through the shared open/import router (so it shares the closure-
 * adjusted read-only guard and per-extension dispatch with the toolbar / Ctrl+I
 * / drag-drop paths). The `filters` thunk is the only thing that varies between
 * formats and contexts (e.g. DMP-only in-project vs. with "All Files" on the
 * start screen), so callers pass the appropriate filter helper.
 */
export function importMenuItem(
  id: string,
  label: string,
  filters: () => FileFilters,
  source: SourceName,
  action?: string,
): AppMenuItem {
  return {
    id,
    label,
    ...(action ? { action } : {}),
    onClick: () => {
      runImport(filters(), source);
    },
  };
}

/** New + Open rows. `source` is the telemetry entry-point tag (e.g. 'hamburger'). */
export function leadingMenuItems(
  t: TFunction,
  actions: { onNewProject: () => void; onOpenProject: () => void },
  source: SourceName,
): AppMenuItem[] {
  return [
    {
      id: 'app-menu-new-project',
      label: t('globalView.actions.newProject'),
      icon: <FilePlusIcon size={ICON_SIZE} />,
      iconColor: MENU_ICON_COLORS.new,
      action: 'new_file',
      onClick: () => {
        setProjectActionSource(source);
        actions.onNewProject();
      },
    },
    {
      id: 'global-open-project-button',
      label: t('globalView.actions.openProject'),
      icon: <FolderOpenIcon size={ICON_SIZE} />,
      iconColor: MENU_ICON_COLORS.open,
      action: 'open_file',
      onClick: () => {
        setProjectActionSource(source);
        actions.onOpenProject();
      },
    },
  ];
}

/** Settings + Debug-logs rows. */
export function serviceMenuItems(
  t: TFunction,
  actions: { onSettings: () => void; onDebug: () => void },
): AppMenuItem[] {
  return [
    {
      id: 'settings-button',
      label: t('globalView.actions.settings'),
      icon: <SettingsIcon size={ICON_SIZE} />,
      iconColor: MENU_ICON_COLORS.settings,
      onClick: actions.onSettings,
    },
    {
      id: 'global-debug-button',
      label: t('globalView.actions.debugLogs'),
      icon: <BugIcon size={ICON_SIZE} />,
      iconColor: MENU_ICON_COLORS.debug,
      onClick: actions.onDebug,
    },
  ];
}

/** Quit row — shares the single close + error-handling contract via quitApp. */
export function quitMenuItem(t: TFunction): AppMenuItem {
  return {
    id: 'global-quit-button',
    label: t('globalView.actions.quit'),
    icon: <QuitIcon size={ICON_SIZE} />,
    iconColor: MENU_ICON_COLORS.quit,
    action: 'quit',
    onClick: quitApp,
  };
}
