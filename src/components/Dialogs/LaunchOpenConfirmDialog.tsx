import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import { trackDialogComplete, clearProjectActionSource } from '../../utils/telemetry';
import { routeOpenedFile } from '../../utils/openOrImport';

/**
 * Consent for a file the OS handed us (#424).
 *
 * Raised for exactly one case (see `needsLaunchConfirm`): a `.stalx` arriving
 * through the launch channel while a CLEAN, locally-owned project is open. The
 * router swaps projects silently there - correct for a file the user just
 * picked, wrong for one a second process forwarded, because on Windows and
 * Linux anything able to run a program as this user can send that forward. The
 * open project is not at risk of losing edits (dirty and SpeleoDB-held projects
 * raise the router's own prompts first), but losing your place unasked is still
 * a surprise, so it gets a click.
 *
 * Confirming re-routes the same path through the ordinary router, which
 * re-checks every guard from scratch.
 */
export default function LaunchOpenConfirmDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const dialogData = useUIStore((s) => s.dialogData);
  const projectName = useProjectStore((s) => s.project?.name);

  const path = dialogData.path as string | undefined;
  const fileName = dialogData.fileName as string | undefined;
  if (!path || !fileName) return null;

  // Declining abandons this open outright, so the pending entry-point source
  // must be dropped - otherwise it survives to mis-attribute a later, unrelated
  // project command.
  const handleCancel = () => {
    clearProjectActionSource();
    closeDialog();
  };

  const handleConfirm = async () => {
    trackDialogComplete('launch-open-confirm');
    closeDialog();
    await routeOpenedFile(path, 'Open Failed');
  };

  return (
    <DialogWrapper
      title={t('dialogs.launchOpenConfirm.title')}
      onClose={handleCancel}
      size="sm"
      data-testid="launch-open-confirm-dialog"
    >
      <div className="space-y-3">
        <p className="text-sm text-text-secondary">
          {t('dialogs.launchOpenConfirm.body', { fileName })}
        </p>
        {projectName && (
          <p className="text-sm text-text-secondary">
            {t('dialogs.launchOpenConfirm.closeNotice', { projectName })}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button onClick={handleCancel} data-testid="launch-open-confirm-cancel">
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleConfirm()}
            data-testid="launch-open-confirm-open"
          >
            {t('dialogs.launchOpenConfirm.confirm')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
