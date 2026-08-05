import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import {
  trackDialogComplete,
  clearProjectActionSource,
  peekProjectActionSource,
} from '../../utils/telemetry';
import { routeOpenedFile } from '../../utils/openOrImport';

/**
 * Consent before a `.stalx` open swaps out a clean, already-open project
 * (#424). `routeOpenedFile` raises this for every entry point that can hit
 * that case - the OS launch channel (a second process forwarded the file, so
 * "the user just picked it" doesn't hold), and equally the picker, drag-drop
 * and Ctrl+O (the user's own click still deserves a confirmation before their
 * open work disappears, not a silent swap). Dirty and SpeleoDB-held projects
 * raise the router's own prompts first and never reach here.
 *
 * `peekProjectActionSource()` distinguishes the two only for copy: an
 * OS-forwarded arrival names itself as such, a user-driven one doesn't imply
 * an outside actor.
 *
 * Confirming re-routes the same path through the ordinary router with
 * `swapConfirmed: true`, so the guard doesn't ask again on the second pass.
 */
export default function LaunchOpenConfirmDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const dialogData = useUIStore((s) => s.dialogData);
  const projectName = useProjectStore((s) => s.project?.name);

  const path = dialogData.path as string | undefined;
  const fileName = dialogData.fileName as string | undefined;
  if (!path || !fileName) return null;

  const isExternal = peekProjectActionSource() === 'os-file-association';

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
    await routeOpenedFile(path, 'Open Failed', { swapConfirmed: true });
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
          {t(
            isExternal ? 'dialogs.launchOpenConfirm.body' : 'dialogs.launchOpenConfirm.bodyDirect',
            { fileName },
          )}
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
