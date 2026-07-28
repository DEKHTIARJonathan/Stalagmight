import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { useSpeleoActions } from '../../hooks/useSpeleoActions';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

/**
 * Optimistic force-edit confirm (#213, E2). Reached from the read-only shell's
 * "Edit without the write lock" affordance (menu / status button), gated on the
 * `allow_force_edit` opt-in. Force-edit lets the user edit WITHOUT the SpeleoDB
 * write lock (to survey offline, or while someone else holds it), so their `.stalx`
 * cannot be merged back until they reconnect and acquire the lock - a data-safety
 * decision that always passes through this single big-red confirm (no one-click
 * path into an unmergeable state).
 *
 * On confirm it enters force-edit (`forceEdit()`, which re-seeds the link → editing
 * + the persistent banner). If someone else already holds the lock we say so, since
 * that user's push would be the one this edit later has to reconcile against.
 */
export default function SpeleoForceEditDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const { forceEdit } = useSpeleoActions();
  // The scan/poll resolves the current holder; surface it so the user knows their
  // edits will have to reconcile against that person's work on reconnect.
  const lockHolder = useSpeleoStore((s) => s.link?.lockHolder ?? null);
  const lockedByOther = useSpeleoStore((s) => s.link?.lockedByOther ?? false);
  const [entering, setEntering] = useState(false);

  const confirm = async () => {
    setEntering(true);
    try {
      // Only dismiss the big-red confirm when force-edit actually engaged. On a backend
      // refusal (opt-in toggled off, link lost, already lock-held) forceEdit returns
      // false and surfaces its own error toast; keep the dialog open so the user is not
      // left believing they entered an editable state while the project stays read-only.
      if (await forceEdit()) closeDialog();
    } finally {
      setEntering(false);
    }
  };

  return (
    <DialogWrapper
      title={t('speleodb.forceEdit.confirm.title')}
      onClose={closeDialog}
      size="md"
      data-testid="speleodb-force-edit-dialog"
    >
      <div className="space-y-4">
        <div
          className="p-3 rounded bg-error-10 border border-error-20 text-error text-sm font-medium"
          data-testid="speleodb-force-edit-warning"
        >
          {t('speleodb.forceEdit.confirm.warning')}
        </div>
        <p className="text-xs text-text-secondary">{t('speleodb.forceEdit.confirm.hint')}</p>
        {lockedByOther && (
          <p className="text-xs text-warning" data-testid="speleodb-force-edit-locked-by">
            {t('speleodb.forceEdit.confirm.lockedBy', {
              email: lockHolder ?? t('speleodb.editBar.someone'),
            })}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button onClick={closeDialog} disabled={entering} data-testid="speleodb-force-edit-cancel">
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => void confirm()}
            disabled={entering}
            data-testid="speleodb-force-edit-confirm"
          >
            {entering
              ? t('speleodb.forceEdit.confirm.entering')
              : t('speleodb.forceEdit.confirm.action')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
