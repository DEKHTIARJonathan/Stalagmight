import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { useEditingBlocked, isEditingBlockedNow } from '../../hooks/useEditingBlocked';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import { trackDialogComplete, clearProjectActionSource } from '../../utils/telemetry';
import { routeOpenedFile } from '../../utils/openOrImport';
import { runAddProjectFile } from '../../utils/addProjectFile';

/**
 * Raised when a `.stalx` is picked through an in-project Import door (#674):
 * either open it as a project (the existing guarded open, re-routed through
 * `routeOpenedFile` so the SpeleoDB hand-back and unsaved-changes prompts still
 * apply) or add its survey data to the open project as one undo step.
 *
 * Add is a mutation, so it is unavailable while editing is blocked; Open as
 * project stays available because it replaces the project rather than editing it.
 */
export default function AddOrOpenProjectDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const dialogData = useUIStore((s) => s.dialogData);
  const projectName = useProjectStore((s) => s.project?.name);
  const editingBlocked = useEditingBlocked();

  const path = dialogData.path as string | undefined;
  const fileName = dialogData.fileName as string | undefined;
  if (!path || !fileName) return null;

  const handleCancel = () => {
    clearProjectActionSource();
    closeDialog();
  };

  const handleOpen = () => {
    trackDialogComplete('add-or-open-project');
    closeDialog();
    void routeOpenedFile(path, 'Open Failed', { swapConfirmed: true });
  };

  const handleAdd = () => {
    if (isEditingBlockedNow()) return;
    trackDialogComplete('add-or-open-project');
    closeDialog();
    void runAddProjectFile(path);
  };

  return (
    <DialogWrapper
      title={t('dialogs.addOrOpenProject.title')}
      onClose={handleCancel}
      size="sm"
      data-testid="add-or-open-project-dialog"
    >
      <div className="space-y-3">
        <p className="text-sm text-text-secondary">
          {t('dialogs.addOrOpenProject.body', { fileName })}
        </p>
        {editingBlocked && (
          <p className="text-sm text-text-secondary" data-testid="add-or-open-project-blocked">
            {t('dialogs.addOrOpenProject.blockedNotice')}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button onClick={handleCancel} data-testid="add-or-open-project-cancel">
            {t('common.actions.cancel')}
          </Button>
          <Button onClick={handleOpen} data-testid="add-or-open-project-open">
            {t('dialogs.addOrOpenProject.openAsProject')}
          </Button>
          <Button
            variant="primary"
            onClick={handleAdd}
            disabled={editingBlocked}
            data-testid="add-or-open-project-add"
          >
            {t('dialogs.addOrOpenProject.addTo', { projectName: projectName ?? '' })}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
