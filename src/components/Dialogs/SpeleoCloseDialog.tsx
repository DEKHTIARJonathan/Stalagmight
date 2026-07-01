import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoActions } from '../../hooks/useSpeleoActions';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

/**
 * Close-flow guard (T2d): shown when closing a SpeleoDB project while you still
 * hold the write lock. Encourages pushing your changes and releasing the lock
 * before leaving (otherwise the lock stays held on the server until you resume or
 * an admin releases it). "Close & keep the lock" is offered for the deliberate
 * "resume later" case.
 */
export default function SpeleoCloseDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const link = useSpeleoStore((s) => s.link);
  const closeProject = useProjectStore((s) => s.closeProject);
  const { busy, done } = useSpeleoActions();

  const dirty = link?.hasUnpushedEdits ?? false;

  const pushReleaseThenClose = async () => {
    // done(null) pushes (when dirty) and releases the lock.
    const resolved = await done(null);
    if (resolved) {
      closeDialog();
      await closeProject();
    }
  };

  const closeKeepingLock = async () => {
    closeDialog();
    await closeProject();
  };

  return (
    <DialogWrapper
      title={t('speleodb.close.title')}
      onClose={closeDialog}
      size="md"
      data-testid="speleodb-close-dialog"
    >
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          {dirty ? t('speleodb.close.dirtyMessage') : t('speleodb.close.message')}
        </p>
        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button onClick={closeDialog} disabled={busy} data-testid="speleodb-close-cancel">
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void closeKeepingLock()}
            disabled={busy}
            data-testid="speleodb-close-keep-lock"
          >
            {t('speleodb.close.keepLock')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void pushReleaseThenClose()}
            disabled={busy}
            data-testid="speleodb-close-push-release"
          >
            {dirty ? t('speleodb.close.pushRelease') : t('speleodb.close.release')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
