import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

/**
 * SpeleoDB conflict / divergence resolution (#198). Reached from the crimson
 * status button (or any hand-off verb that reported `divergence_needed`) when the
 * local copy and the server have diverged.
 *
 * Scope note: **Keep local** is functional (dismiss and keep your version). The
 * destructive **Take remote** and **Save local copy** paths need backend support
 * (a force re-pull + a save-as) that lands with the full #198 work — they are
 * stubbed here (a "coming soon" notice) rather than half-wired, so no data is at
 * risk. This dialog is the seam those paths plug into.
 */
export default function SpeleoDivergenceDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const showToast = useUIStore((s) => s.showToast);
  const clearDivergence = useSpeleoStore((s) => s.clearDivergence);

  const keepLocal = () => {
    clearDivergence();
    closeDialog();
  };

  const comingSoon = () => showToast(t('speleodb.divergence.comingSoon'), 'speleodb-divergence-soon');

  return (
    <DialogWrapper
      title={t('speleodb.divergence.title')}
      onClose={closeDialog}
      size="md"
      data-testid="speleodb-divergence-dialog"
    >
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">{t('speleodb.divergence.description')}</p>

        <div className="space-y-2">
          <button
            type="button"
            onClick={keepLocal}
            className="w-full text-left p-3 rounded border border-border hover:bg-panel"
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
            className="w-full text-left p-3 rounded border border-border hover:bg-panel opacity-70"
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
            onClick={comingSoon}
            className="w-full text-left p-3 rounded border border-border hover:bg-panel opacity-70"
            data-testid="speleodb-divergence-save-copy"
          >
            <div className="text-sm font-medium text-text-primary">
              {t('speleodb.divergence.saveCopy.label')}{' '}
              <span className="text-xs text-text-secondary">
                {t('speleodb.divergence.soonTag')}
              </span>
            </div>
            <div className="text-xs text-text-secondary">
              {t('speleodb.divergence.saveCopy.help')}
            </div>
          </button>
        </div>

        <div className="flex justify-end pt-2 border-t border-border">
          <Button onClick={closeDialog} data-testid="speleodb-divergence-cancel">
            {t('common.actions.cancel')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
