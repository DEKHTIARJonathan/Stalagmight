import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsSection } from './SettingsSection';
import { Button } from '../../common/Button';
import { useUIStore } from '../../../store/uiStore';
import { useSpeleoStore } from '../../../store/speleoStore';
import { releaseSpeleoLock } from '../../../utils/releaseSpeleoLock';
import { useProjectStore } from '../../../store/projectStore';
import { invokeIpc } from '../../../utils/ipc';
import { humanizeSpeleoError } from '../../../utils/speleoError';
import { holdsWriteLock } from '../../../utils/quit';
import { TOAST_KEYS } from '../../../utils/toastKeys';

/**
 * Explicit lock recovery, available to write-tier users for their own locks and
 * to administrators for locks held by another account.
 */
export function SpeleoAdminTab() {
  const { t } = useTranslation();
  const showToast = useUIStore((s) => s.showToast);
  const link = useSpeleoStore((s) => s.link);
  const busy = useSpeleoStore((s) => s.busy);
  const refreshLinkStatus = useSpeleoStore((s) => s.refreshLinkStatus);

  const [releasing, setReleasing] = useState(false);

  const handleRelease = useCallback(async () => {
    if (useSpeleoStore.getState().busy) return;
    const busyToken = useSpeleoStore.getState().beginBusy();
    setReleasing(true);
    try {
      const session = useSpeleoStore.getState().sessionGeneration;
      const path = useProjectStore.getState().project?.file_path;
      const current = () => useSpeleoStore.getState().sessionGeneration === session &&
        useProjectStore.getState().project?.file_path === path;
      if (useSpeleoStore.getState().link?.hasUnpushedEdits) {
        if (!await releaseSpeleoLock(current, false)) return;
      } else {
        await invokeIpc('speleodb_release_current_lock');
      }
      if (!current()) return;
      await refreshLinkStatus();
      showToast(t('speleodb.lock.released'), TOAST_KEYS.SPELEODB_LOCK, 'success');
    } catch (e) {
      showToast(humanizeSpeleoError(e, t('speleodb.lock.releaseFailed')), TOAST_KEYS.SPELEODB_LOCK, 'error');
    } finally {
      useSpeleoStore.getState().endBusy(busyToken);
      setReleasing(false);
    }
  }, [refreshLinkStatus, showToast, t]);

  const holder = link?.lockHolder ?? null;
  const iHoldLock = holdsWriteLock(link);

  return (
    <div data-testid="speleodb-admin-tab">
      {/* Lock */}
      <SettingsSection title={t('speleodb.lock.title')}>
        {/* Show the release UI whenever a lock is held - by someone else (`holder`
            set) OR by us. After acquiring a lock, `editState` flips to 'editing' but
            `lockHolder` can stay null (the fast start-editing path does not re-seed
            it), so gating on `holder` alone would strand the very stuck-lock recovery
            this section exists for. `iHoldLock` uses the self copy (no holder email). */}
        {holder || iHoldLock ? (
          <>
            <p className="text-sm mb-2" data-testid="speleodb-lock-holder">
              {iHoldLock
                ? t('speleodb.lock.heldByYou')
                : t('speleodb.lock.heldBy', { email: holder })}
            </p>
            {iHoldLock && (
              <p className="text-warning text-xs mb-2" data-testid="speleodb-lock-self-warning">
                {t('speleodb.lock.selfWarning')}
              </p>
            )}
            <Button
              variant="secondary"
              disabled={releasing || busy}
              onClick={() => void handleRelease()}
              data-testid="speleodb-lock-release"
            >
              {releasing ? t('speleodb.lock.releasing') : t('speleodb.lock.releaseButton')}
            </Button>
          </>
        ) : (
          <p className="text-text-secondary text-sm" data-testid="speleodb-lock-none">
            {t('speleodb.lock.none')}
          </p>
        )}
      </SettingsSection>

    </div>
  );
}
