import { useTranslation } from 'react-i18next';
import { Button } from '../common/Button';
import { AlertDialog } from './AlertDialog';

interface SpeleoAdoptConfirmProps {
  /** Server-side name of the Ariane project being adopted (for the body copy). */
  projectName: string;
  onCancel: () => void;
  onConfirm: () => void;
  /** Disable the actions while the adopt is in flight. */
  busy?: boolean;
}

/**
 * The one-time Ariane (.tml-only) adoption confirm (#214), shared so both the
 * Open-from-SpeleoDB browser and GlobalView's remote-project rows (#218) offer the
 * identical warning + consequences before flipping a project to Stalagmight-owned.
 * Presentational only - the caller wires `onConfirm` to `useOpenRemoteProject`'s
 * `adoptRemote`. Test ids are kept stable for the #214 component tests.
 */
export function SpeleoAdoptConfirm({
  projectName,
  onCancel,
  onConfirm,
  busy = false,
}: SpeleoAdoptConfirmProps) {
  const { t } = useTranslation();
  return (
    <AlertDialog
      open
      title={t('speleodb.adopt.confirmTitle')}
      onClose={onCancel}
      data-testid="speleodb-adopt-confirm"
      actions={
        <>
          <Button onClick={onCancel} disabled={busy} data-testid="speleodb-adopt-cancel">
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={busy}
            data-primary-action=""
            data-testid="speleodb-adopt-confirm-btn"
          >
            {t('speleodb.adopt.confirmButton')}
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm text-text-secondary">
        <p>{t('speleodb.adopt.confirmBody', { name: projectName })}</p>
        <p>{t('speleodb.adopt.confirmConsequence')}</p>
      </div>
    </AlertDialog>
  );
}
