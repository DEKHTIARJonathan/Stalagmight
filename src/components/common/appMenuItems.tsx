/**
 * Shared AppMenu rows used by BOTH the GlobalView hamburger and the in-project
 * hamburger (useProjectMenuItems), so the common New / Open / Settings / Debug /
 * Quit entries are defined exactly once instead of being hand-maintained twice
 * (they had already drifted - e.g. the quit handler). Item ids match the
 * legacy/e2e selectors so existing tests keep working.
 */
import type { TFunction } from 'i18next';
import {
  FilePlusIcon,
  FolderOpenIcon,
  DownloadIcon,
  SettingsIcon,
  BugIcon,
  QuitIcon,
} from './icons';
import { SpeleoBadgedIcon } from './SpeleoBadgedIcon';
import { MENU_ICON_COLORS } from './menuColors';
import { setProjectActionSource, type SourceName } from '../../utils/telemetry';
import { quitApp } from '../../utils/quit';
import { pickAndRoute } from '../../utils/openOrImport';
import { openOrImportFilters } from '../../utils/fileDialogs';
import type { AppMenuItem } from './AppMenu';

const ICON_SIZE = 18;

/**
 * The hamburger's "Import" group - one door (#407): its single row offers the
 * SAME unified filter set as the Open row and every other entry point, and
 * routes through the shared open/import router (per-extension dispatch, the DMP
 * read-only guard, the `.stalx` replacement prompts). The two words survive
 * because different survey packages use either; the behavior is one. Shared by
 * the GlobalView and in-project hamburgers so the group can't drift between
 * them (GlobalView used to carry five per-format rows here, and the in-project
 * copy used to disable the group whenever editing was blocked - too broad, now
 * that non-DMP imports legally close-and-create and `.stalx` is a plain open;
 * the router rejects exactly the additive DMP case, with a tailored message).
 * Kept as a one-row submenu so the menu structure (and the e2e helper that
 * drives it) is identical in both views.
 */
export function importMenuGroup(t: TFunction): AppMenuItem {
  return {
    id: 'global-import-menu-button',
    label: t('globalView.actions.import'),
    icon: <DownloadIcon size={ICON_SIZE} />,
    iconColor: MENU_ICON_COLORS.import,
    submenu: [
      {
        id: 'global-import-dmp-button',
        label: t('globalView.actions.importSurveyData'),
        action: 'import_dmp',
        onClick: () => {
          setProjectActionSource('hamburger');
          void pickAndRoute(openOrImportFilters(), 'Import Failed');
        },
      },
    ],
  };
}

/** New + Open rows. `source` is the telemetry entry-point tag (e.g. 'hamburger'). */
export function leadingMenuItems(
  t: TFunction,
  actions: { onNewProject: () => void },
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
      // The one door (#407): the hamburger Open row is the same unified
      // Open/Import as the toolbar button and Ctrl+O - every file the app
      // supports, routed by extension through routeOpenedFile. Id kept for
      // e2e/test-id continuity.
      id: 'global-open-project-button',
      label: t('globalView.actions.openOrImport'),
      icon: <FolderOpenIcon size={ICON_SIZE} />,
      iconColor: MENU_ICON_COLORS.open,
      action: 'open_file',
      onClick: () => {
        setProjectActionSource(source);
        void pickAndRoute(openOrImportFilters(), 'Open Failed');
      },
    },
  ];
}

/**
 * "Open from SpeleoDB" row (#203) - opens the remote project browser. Shared by
 * the GlobalView hamburger and the in-project menu so both reach the same
 * production browser (the dev spike entry it replaces was GlobalView-only).
 */
export function openFromSpeleoDbMenuItem(
  t: TFunction,
  actions: { onOpen: () => void },
): AppMenuItem {
  return {
    id: 'open-from-speleodb-button',
    label: t('globalView.actions.openFromSpeleoDb'),
    icon: (
      <SpeleoBadgedIcon
        badge={<FolderOpenIcon size={11} />}
        badgeColor="text-blue-400"
        size={ICON_SIZE}
        testIdPrefix="open-from-speleodb-button-icon"
      />
    ),
    onClick: actions.onOpen,
  };
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

/** Quit row - shares the single close + error-handling contract via quitApp. */
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
