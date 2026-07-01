import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useSpeleoActions } from '../../hooks/useSpeleoActions';
import { convertToUnmanagedStalx } from '../../utils/projectActions';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

/**
 * SpeleoDB conflict / divergence resolution (#198). Reached from the crimson
 * status button (or any hand-off verb that reported `divergence_needed`) when the
 * local copy and the server have diverged.
 *
 * Two live resolutions:
 * - **Keep my local version** (fix 5): route to the push dialog so the user
 *   uploads their version to resolve it (the push re-fences and, if it still
 *   diverges, lands back here - never a silent clobber).
 * - **Save my version as a local copy** (fix 11): keep the locally-edited work by
 *   converting it to a plain unmanaged `.stalx` (Save-As), abandoning the managed
 *   copy (a later Open-from-SpeleoDB re-pulls the clean server tip).
 *
 * **Take the SpeleoDB version** (a force re-pull that discards local edits) still
 * needs backend support and stays stubbed.
 */
export default function SpeleoDivergenceDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const openDialog = useUIStore((s) => s.openDialog);
  const showToast = useUIStore((s) => s.showToast);
  const clearDivergence = useSpeleoStore((s) => s.clearDivergence);
  const editState = useSpeleoStore((s) => s.link?.editState ?? 'read-only');
  const { startEditing } = useSpeleoActions();
  const [converting, setConverting] = useState(false);

  // Closing without resolving leaves the divergence for later, but must CLEAR the
  // transient flag so the App-level effect doesn't immediately re-open this dialog
  // (fix 3). The button stays crimson while `remoteState === 'conflict'`, so the
  // user can reopen from there.
  const handleCancel = () => {
    clearDivergence();
    closeDialog();
  };

  // Keep local → push your version. While we hold the lock, route to the push
  // dialog. Without the lock, acquire it first (Start editing): if our BASE actually
  // matches the server the lock is granted and the user can then push their version;
  // if it still diverges, startEditing re-reports it and the App effect re-opens this
  // dialog - a real next step, not a dead-end toast (fix 11).
  const keepLocal = () => {
    clearDivergence();
    if (editState === 'editing') {
      openDialog('speleodb-done', { mode: 'push' });
    } else {
      closeDialog();
      void startEditing();
    }
  };

  const saveCopy = async () => {
    setConverting(true);
    try {
      if (await convertToUnmanagedStalx()) {
        clearDivergence();
        closeDialog();
      }
    } finally {
      setConverting(false);
    }
  };

  const comingSoon = () => showToast(t('speleodb.divergence.comingSoon'), 'speleodb-divergence-soon');

  return (
    <DialogWrapper
      title={t('speleodb.divergence.title')}
      onClose={handleCancel}
      size="md"
      data-testid="speleodb-divergence-dialog"
    >
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">{t('speleodb.divergence.description')}</p>

        <div className="space-y-2">
          <button
            type="button"
            onClick={keepLocal}
            disabled={converting}
            className="w-full text-left p-3 rounded border border-border hover:bg-panel disabled:opacity-50"
            data-testid="speleodb-divergence-keep-local"
          >
            <div className="text-sm font-medium text-text-primary">
              {t('speleodb.divergence.keepLocal.label')}
            </div>
            <div className="text-xs text-text-secondary">
              {t('speleodb.divergence.keepLocal.help')}
            </div>
          </button>

          <button
            type="button"
            onClick={comingSoon}
            disabled={converting}
            className="w-full text-left p-3 rounded border border-border hover:bg-panel opacity-70 disabled:opacity-50"
            data-testid="speleodb-divergence-take-remote"
          >
            <div className="text-sm font-medium text-text-primary">
              {t('speleodb.divergence.takeRemote.label')}{' '}
              <span className="text-xs text-text-secondary">
                {t('speleodb.divergence.soonTag')}
              </span>
            </div>
            <div className="text-xs text-text-secondary">
              {t('speleodb.divergence.takeRemote.help')}
            </div>
          </button>

          <button
            type="button"
            onClick={() => void saveCopy()}
            disabled={converting}
            className="w-full text-left p-3 rounded border border-border hover:bg-panel disabled:opacity-50"
            data-testid="speleodb-divergence-save-copy"
          >
            <div className="text-sm font-medium text-text-primary">
              {t('speleodb.divergence.saveCopy.label')}
            </div>
            <div className="text-xs text-text-secondary">
              {converting
                ? t('speleodb.divergence.saveCopy.converting')
                : t('speleodb.divergence.saveCopy.help')}
            </div>
          </button>
        </div>

        <div className="flex justify-end pt-2 border-t border-border">
          <Button onClick={handleCancel} disabled={converting} data-testid="speleodb-divergence-cancel">
            {t('common.actions.cancel')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
