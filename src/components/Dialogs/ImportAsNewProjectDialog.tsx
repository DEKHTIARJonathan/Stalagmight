import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { useProject } from '../../hooks/useProject';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import { trackDialogComplete, clearProjectActionSource } from '../../utils/telemetry';
import { routeOpenedFile } from '../../utils/openOrImport';

/**
 * Confirm dialog (#391) shown instead of the old close-first dead end when a
 * new-project-only format (GPX/Ariane/Compass/Walls) is picked while a project
 * is already open. Confirming closes the current project - through the SAME
 * guarded path as File > Close, so an unsaved-changes or SpeleoDB hand-back
 * prompt still applies - and only then re-routes the picked file, which with no
 * project open falls through to the normal new-project import chain.
 *
 * If the close is deferred to a guard dialog (unsaved changes, SpeleoDB hand-
 * back), this dialog simply steps aside: `handleCloseProject` already opened
 * that dialog, so there is nothing left for this handler to do. The user can
 * re-launch the import once the project is actually closed.
 */
export default function ImportAsNewProjectDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const dialogData = useUIStore((s) => s.dialogData);
  const projectName = useProjectStore((s) => s.project?.name);
  const { handleCloseProject } = useProject();

  const path = dialogData.path as string | undefined;
  const fileName = dialogData.fileName as string | undefined;
  if (!path || !fileName) return null;

  // Cancel / backdrop-close / a non-continuing exit all abandon this import
  // outright, so the pending entry-point source (handed off by openOrImport's
  // `handedOff = true`) must be cleared here - otherwise it survives to
  // mis-attribute a later, unrelated project command.
  const handleAbandon = () => {
    clearProjectActionSource();
    closeDialog();
  };

  const handleConfirm = async () => {
    trackDialogComplete('import-as-new-project');
    const result = await handleCloseProject();
    if (!result.success) {
      clearProjectActionSource();
      return;
    }
    closeDialog();
    await routeOpenedFile(path);
  };

  return (
    <DialogWrapper
      title={t('dialogs.importAsNewProject.title')}
      onClose={handleAbandon}
      size="sm"
      data-testid="import-as-new-project-dialog"
    >
      <div className="space-y-3">
        <p className="text-sm text-text-secondary">
          {t('dialogs.importAsNewProject.body', { fileName })}
        </p>
        {projectName && (
          <p className="text-sm text-text-secondary">
            {t('dialogs.importAsNewProject.closeNotice', { projectName })}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button onClick={handleAbandon} data-testid="import-as-new-project-cancel">
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleConfirm()}
            data-testid="import-as-new-project-confirm"
          >
            {t('dialogs.importAsNewProject.confirm')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
