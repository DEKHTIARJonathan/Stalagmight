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
import { useUIStore } from '../../store/uiStore';
import { setProjectActionSource } from '../../utils/telemetry';
import { MENU_ICON_COLORS } from '../common/menuColors';
import { leadingMenuItems, serviceMenuItems, quitMenuItem } from '../common/appMenuItems';
import type { AppMenuItem } from '../common/AppMenu';
import {
  SaveIcon,
  CloseIcon,
  DownloadIcon,
  ExportIcon,
  SlidersIcon,
  InfoIcon,
  DatabaseIcon,
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
    handleImportDmp,
    handleImportGpx,
  } = useProject();
  const openDialog = useUIStore((s) => s.openDialog);
  const showDevStats = useUIStore((s) => s.showDevStats);
  const toggleDisplay = useUIStore((s) => s.toggleDisplay);

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
      if (result && result.success) {
        await handleCloseProject();
      }
    };

    // "Project Details" = clear the selection so the Details panel shows
    // <ProjectStats>, and make sure the panel is open.
    const showProjectDetails = () => {
      const ui = useUIStore.getState();
      ui.clearSelection();
      if (!ui.detailPanelOpen) ui.toggleDetailPanel();
    };

    return [
      ...leadingMenuItems(t, { onNewProject: handleNewProject, onOpenProject: handleOpenProject }, 'hamburger'),
      { id: 'project-menu-sep-1', label: '', separator: true },
      {
        id: 'toolbar-save-button',
        label: t('common.actions.save'),
        icon: <SaveIcon size={sz} />,
        iconColor: MENU_ICON_COLORS.save,
        dangerBg: saveFailed,
        action: 'save',
        onClick: () => { void onSave(); },
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
        submenu: [
          {
            id: 'global-import-dmp-button',
            label: t('globalView.actions.importDmp'),
            action: 'import_dmp',
            onClick: () => { setProjectActionSource('hamburger'); handleImportDmp(); },
          },
          {
            id: 'global-import-gpx-button',
            label: t('globalView.actions.importGpx'),
            onClick: () => { setProjectActionSource('hamburger'); handleImportGpx(); },
          },
        ],
      },
      {
        id: 'toolbar-export-button',
        label: t('common.actions.export'),
        icon: <ExportIcon size={sz} />,
        iconColor: MENU_ICON_COLORS.export,
        action: 'export',
        onClick: () => openDialog('export'),
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
        onClick: () => { void handleCloseProject(); },
      },
      quitMenuItem(t),
    ];
  }, [t, openDialog, showDevStats, toggleDisplay, onSave, saveFailed, handleNewProject, handleOpenProject, handleSaveProjectAs, handleCloseProject, handleImportDmp, handleImportGpx]);
}
