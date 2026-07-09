/**
 * Builds the in-project hamburger (AppMenu) items for SingleSystemView.
 *
 * Reuses the shared GlobalView rows (New/Open/Settings/Debug/Quit) from
 * appMenuItems and adds the project-specific actions (Save, Save As, Save and
 * Close, Close Project, Export, Project Settings, Project Details). Item ids
 * reuse the GlobalView/legacy test-ids for matching actions so existing e2e
 * selectors/helpers keep working.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useProject } from '../../hooks/useProject';
import { useUIStore, isMapReadOnly } from '../../store/uiStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useSpeleoActions } from '../../hooks/useSpeleoActions';
import { SpeleoDbLogo } from '../common/SpeleoDbLogo';
import { SpeleoBadgedIcon, PushGlyph, RefreshGlyph, EditNoLockGlyph } from '../common/SpeleoBadgedIcon';
import { dmpImportFilters } from '../../utils/fileDialogs';
import { setSource } from '../../utils/telemetry';
import { MENU_ICON_COLORS } from '../common/menuColors';
import { leadingMenuItems, serviceMenuItems, quitMenuItem, importMenuItem, openFromSpeleoDbMenuItem } from '../common/appMenuItems';
import type { AppMenuItem } from '../common/AppMenu';
import {
  SaveIcon,
  CloseIcon,
  DownloadIcon,
  ExportIcon,
  SlidersIcon,
  InfoIcon,
  DatabaseIcon,
  PencilIcon,
  LockIcon,
  FilePlusIcon,
} from '../common/icons';

interface UseProjectMenuItemsArgs {
  /** The SingleSystemView-wrapped save (cancels autosave, then saves). */
  onSave: (opts?: { closeAfterSave?: boolean }) => Promise<{ success: boolean } | null | undefined>;
  /** A save (auto or manual) failed — flag the Save row with a dark-red bg. */
  saveFailed?: boolean;
}

export function useProjectMenuItems({ onSave, saveFailed = false }: UseProjectMenuItemsArgs): AppMenuItem[] {
  const { t } = useTranslation();
  const {
    handleNewProject,
    handleOpenProject,
    handleSaveProjectAs,
    handleCloseProject,
  } = useProject();
  const openDialog = useUIStore((s) => s.openDialog);
  const showDevStats = useUIStore((s) => s.showDevStats);
  const toggleDisplay = useUIStore((s) => s.toggleDisplay);
  // SpeleoDB submenu (T2d) - only for a remote project.
  const speleoLink = useSpeleoStore((s) => s.link);
  // The signed-in session gates "Publish to SpeleoDB" (a local project can only be
  // published while logged in).
  const speleoSession = useSpeleoStore((s) => s.session);
  const { busy: speleoBusy, startEditing, update, done } = useSpeleoActions();
  // The read-only map (closure-adjusted view, or Plan/Export #243) rejects imports
  // - they add sections. Disable the Import item up front (the toolbar Import
  // button and Ctrl+I already do), so the user isn't sent through a file picker
  // only to be rejected after choosing.
  const mapReadOnly = useUIStore(isMapReadOnly);

  return useMemo(() => {
    const sz = 18;

    const saveAndClose = async () => {
      // Pass the close intent so a deferred Save-As (the overwrite-confirm dialog)
      // still closes the project after it saves. A direct save returns the result
      // and we close here; a save routed to the overwrite dialog returns null and
      // that dialog finishes the close once the user confirms.
      const result = await onSave({ closeAfterSave: true });
      // Only leave the project if the save actually succeeded (a cancelled
      // Save As returns null; an integrity/permission block returns success:false).
      // handleCloseProject now owns the held-lock close guard (fix 1), so the T2d
      // "push & release before closing" prompt fires here too.
      if (result && result.success) {
        await handleCloseProject();
      }
    };

    // "Project Details" = clear the selection so the Details panel shows
    // <ProjectStats>, then reveal the panel. revealDetailPanel (not
    // toggleDetailPanel) so a hover-mode user's reveal preference isn't silently
    // overwritten with 'pin' just to view stats.
    const showProjectDetails = () => {
      const ui = useUIStore.getState();
      ui.clearSelection();
      ui.revealDetailPanel();
    };

    return [
      ...leadingMenuItems(t, { onNewProject: handleNewProject, onOpenProject: handleOpenProject }, 'hamburger'),
      // "Open from SpeleoDB" needs a signed-in session (it lists the caller's
      // remote projects), so hide it when logged out.
      ...(speleoSession?.loggedIn
        ? [openFromSpeleoDbMenuItem(t, { onOpen: () => openDialog('open-from-speleodb') })]
        : []),
      // Publish to SpeleoDB - only for a LOCAL project (not already linked) while
      // signed in (a publish needs a session).
      ...(!speleoLink && speleoSession?.loggedIn
        ? [
            {
              id: 'publish-to-speleodb-menu',
              label: t('speleodb.publish.menuItem'),
              icon: (
                <SpeleoBadgedIcon badge={<FilePlusIcon size={11} />} badgeColor="text-green-400" size={sz} />
              ),
              onClick: () => openDialog('publish-to-speleodb'),
            },
          ]
        : []),
      // SpeleoDB submenu (T2d) - only when a remote project is open.
      ...(speleoLink
        ? [
            {
              id: 'speleodb-menu',
              label: t('speleodb.menu.title'),
              icon: <SpeleoDbLogo size={sz} />,
              submenu: [
                speleoLink.editState === 'editing' && speleoLink.forceEditing
                  ? {
                      // #213: a force-editor holds no lock, so the top action is
                      // Reconnect (acquire + reconcile), NOT Unlock. Done/push are
                      // backend-guarded for this state, so we never offer them here.
                      id: 'speleodb-menu-reconnect',
                      label: t('speleodb.forceEdit.reconnect'),
                      icon: (
                        <SpeleoBadgedIcon badge={<LockIcon size={9} />} badgeColor="text-yellow-400" size={sz} />
                      ),
                      disabled: speleoBusy,
                      onClick: () => {
                        void startEditing();
                      },
                    }
                  : speleoLink.editState === 'editing'
                  ? {
                      id: 'speleodb-menu-unlock',
                      label: t('speleodb.menu.unlock'),
                      icon: (
                        <SpeleoBadgedIcon badge={<LockIcon size={9} />} badgeColor="text-green-400" size={sz} />
                      ),
                      disabled: speleoBusy,
                      onClick: () => {
                        // Release; the push&release dialog when there are local edits.
                        if (speleoLink.hasUnpushedEdits) openDialog('speleodb-done');
                        else void done(null);
                      },
                    }
                  : {
                      id: 'speleodb-menu-lock',
                      label: t('speleodb.menu.lock'),
                      icon: (
                        <SpeleoBadgedIcon badge={<PencilIcon size={9} />} badgeColor="text-yellow-400" size={sz} />
                      ),
                      disabled: speleoBusy,
                      onClick: () => {
                        void startEditing();
                      },
                    },
                {
                  id: 'speleodb-menu-push',
                  label: t('speleodb.menu.push'),
                  icon: (
                    <SpeleoBadgedIcon badge={<PushGlyph size={9} />} badgeColor="text-green-400" size={sz} />
                  ),
                  // Push-without-unlock only makes sense while editing with edits.
                  disabled: speleoBusy || speleoLink.editState !== 'editing' || !speleoLink.hasUnpushedEdits,
                  // Collect a commit message via the done dialog in push mode (like
                  // push & release, but the lock is retained - fix 8).
                  onClick: () => openDialog('speleodb-done', { mode: 'push' }),
                },
                {
                  id: 'speleodb-menu-refresh',
                  label: t('speleodb.menu.refresh'),
                  icon: (
                    <SpeleoBadgedIcon badge={<RefreshGlyph size={11} />} badgeColor="text-blue-400" size={sz} />
                  ),
                  disabled: speleoBusy,
                  onClick: () => {
                    void update();
                  },
                },
                // #213: optimistic force-edit - edit WITHOUT the lock, behind the
                // `allow_force_edit` opt-in (hidden otherwise) and a big-red confirm.
                // Only offered while read-only; a force-editor uses Reconnect above.
                ...(speleoLink.forceEditAllowed && speleoLink.editState !== 'editing'
                  ? [
                      {
                        id: 'speleodb-menu-edit-without-lock',
                        label: t('speleodb.menu.editWithoutLock'),
                        icon: (
                          <SpeleoBadgedIcon
                            badge={<EditNoLockGlyph size={11} />}
                            badgeColor="text-red-500"
                            size={sz}
                          />
                        ),
                        disabled: speleoBusy,
                        onClick: () => openDialog('speleodb-force-edit'),
                      },
                    ]
                  : []),
              ],
            },
          ]
        : []),
      { id: 'project-menu-sep-1', label: '', separator: true },
      {
        id: 'toolbar-save-button',
        label: t('common.actions.save'),
        icon: <SaveIcon size={sz} />,
        iconColor: MENU_ICON_COLORS.save,
        dangerBg: saveFailed,
        action: 'save',
        // Tag the save with the toolbar/menu entry point (the old toolbar Save
        // button did this; the menu must too, or save_project loses its source).
        onClick: () => { setSource('toolbar'); void onSave(); },
      },
      {
        id: 'project-menu-save-as',
        label: t('singleView.menu.saveAs'),
        icon: <SaveIcon size={sz} />,
        iconColor: MENU_ICON_COLORS.save,
        action: 'save_as',
        onClick: () => { void handleSaveProjectAs(); },
      },
      {
        id: 'project-menu-save-and-close',
        label: t('singleView.menu.saveAndClose'),
        icon: <SaveIcon size={sz} />,
        iconColor: MENU_ICON_COLORS.save,
        onClick: () => { void saveAndClose(); },
      },
      { id: 'project-menu-sep-2', label: '', separator: true },
      {
        id: 'global-import-menu-button',
        label: t('globalView.actions.import'),
        icon: <DownloadIcon size={sz} />,
        iconColor: MENU_ICON_COLORS.import,
        disabled: mapReadOnly,
        submenu: [
          // DMP-only filter (dmpImportFilters, no "All Files"): with a project
          // open, an unrelated file — notably a `.stalx` — must NOT be pickable
          // here, or the shared router would open it and replace the current
          // project. DMP is the only additive in-project import; GPX/Ariane/
          // Compass start new projects (the router rejects those if dropped/
          // opened while a project is open).
          importMenuItem('global-import-dmp-button', t('globalView.actions.importDmp'), dmpImportFilters, 'hamburger', 'import_dmp'),
        ],
      },
      {
        id: 'toolbar-export-button',
        label: t('common.actions.export'),
        icon: <ExportIcon size={sz} />,
        iconColor: MENU_ICON_COLORS.export,
        action: 'export',
        onClick: () => { setSource('toolbar'); openDialog('export'); },
      },
      { id: 'project-menu-sep-3', label: '', separator: true },
      {
        id: 'project-menu-project-settings',
        label: t('singleView.menu.projectSettings'),
        icon: <SlidersIcon size={sz} />,
        iconColor: MENU_ICON_COLORS.projectSettings,
        onClick: () => openDialog('project-settings'),
      },
      {
        id: 'project-menu-project-details',
        label: t('singleView.menu.projectDetails'),
        icon: <InfoIcon size={sz} />,
        iconColor: MENU_ICON_COLORS.projectDetails,
        onClick: showProjectDetails,
      },
      { id: 'project-menu-sep-4', label: '', separator: true },
      ...serviceMenuItems(t, { onSettings: () => openDialog('settings'), onDebug: () => openDialog('debug') }),
      {
        id: 'display-toggle-showDevStats',
        label: t('singleView.menu.devStats'),
        icon: <DatabaseIcon size={sz} />,
        iconColor: MENU_ICON_COLORS.debug,
        checked: showDevStats,
        onClick: () => toggleDisplay('showDevStats'),
      },
      { id: 'project-menu-sep-5', label: '', separator: true },
      {
        id: 'back-button',
        label: t('singleView.menu.closeProject'),
        icon: <CloseIcon size={sz} />,
        iconColor: MENU_ICON_COLORS.close,
        // handleCloseProject now routes a lock-held close through the speledb-close
        // guard itself (fix 1).
        onClick: () => { void handleCloseProject(); },
      },
      quitMenuItem(t),
    ];
  }, [t, openDialog, showDevStats, toggleDisplay, mapReadOnly, onSave, saveFailed, handleNewProject, handleOpenProject, handleSaveProjectAs, handleCloseProject, speleoLink, speleoSession, speleoBusy, startEditing, update, done]);
}
