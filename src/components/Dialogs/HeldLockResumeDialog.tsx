import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoStore } from '../../store/speleoStore';
import { humanizeSpeleoError } from '../../utils/speleoError';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

/**
 * Held-lock resume/release prompt (#201, B1). SpeleoDB has no server-side lock
 * TTL, so a crashed/abandoned session leaves its write locks held. On login /
 * app-open a single `list_projects` scan finds the locks THIS user holds; if any,
 * this prompt offers to resolve them:
 * - **Release all locks** - `DELETE /user/release_all_locks/`, freeing them for
 *   other editors.
 * - **Keep working** - dismiss and leave the locks held (the user is still using
 *   them; the open project, if held, is already resumed into its editing state).
 * - Closing the dialog (X) is the "do nothing" exit - same as Keep working.
 */
export default function HeldLockResumeDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const showToast = useUIStore((s) => s.showToast);
  const heldLocks = useSpeleoStore((s) => s.heldLocks);
  const releaseAllLocks = useSpeleoStore((s) => s.releaseAllLocks);
  const clearHeldLocks = useSpeleoStore((s) => s.clearHeldLocks);
  const [releasing, setReleasing] = useState(false);

  // Keep / Do-nothing: leave the locks held and just dismiss the prompt.
  const keep = () => {
    clearHeldLocks();
    closeDialog();
  };

  const releaseAll = async () => {
    setReleasing(true);
    try {
      await releaseAllLocks();
      closeDialog();
    } catch (e) {
      // Release failed: keep the prompt open so the user can retry.
      showToast(
        humanizeSpeleoError(e, t('speleodb.heldLocks.releaseFailed')),
        'speleodb-release-all-error',
      );
    } finally {
      setReleasing(false);
    }
  };

  const locks = heldLocks ?? [];

  return (
    <DialogWrapper
      title={t('speleodb.heldLocks.title')}
      onClose={keep}
      size="md"
      data-testid="speleodb-held-lock-dialog"
    >
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          {t('speleodb.heldLocks.description', { count: locks.length })}
        </p>

        <ul className="max-h-40 overflow-y-auto rounded border border-border divide-y divide-border">
          {locks.map((lock) => (
            <li
              key={lock.projectId}
              className="px-3 py-2 text-sm text-text-primary"
              data-testid={`speleodb-held-lock-${lock.projectId}`}
            >
              {lock.projectName}
            </li>
          ))}
        </ul>

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button onClick={keep} disabled={releasing} data-testid="speleodb-held-lock-keep">
            {t('speleodb.heldLocks.keep')}
          </Button>
          <Button
            variant="danger"
            onClick={() => void releaseAll()}
            disabled={releasing}
            data-testid="speleodb-held-lock-release-all"
          >
            {releasing
              ? t('speleodb.heldLocks.releasing')
              : t('speleodb.heldLocks.releaseAll')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
