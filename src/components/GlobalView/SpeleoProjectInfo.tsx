import { useTranslation } from 'react-i18next';
import type { SpeleoProjectSummary } from '../../types/ipc.generated';
import { SpeleoDbLogo } from '../common/SpeleoDbLogo';
import type { SpeleoLockInfo } from './SpeleoLockBadge';

/** Server identity, access and lock state, independent of local cache availability. */
export function SpeleoProjectInfo({ summary, lock, testIdPrefix }: {
  summary: SpeleoProjectSummary;
  lock: SpeleoLockInfo;
  testIdPrefix: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 text-xs text-text-secondary" data-testid={`${testIdPrefix}-info`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5"><SpeleoDbLogo size={16} />SpeleoDB</span>
        <span className="rounded bg-background px-2 py-1" data-testid={`${testIdPrefix}-permission`}>
          {t('speleodb.projectListing.permission', {
            permission: t(`speleodb.projectListing.permissions.${summary.permission ?? 'unknown'}`),
          })}
        </span>
      </div>
      <div className="break-words" data-testid={`${testIdPrefix}-lock`}>
        {lock.lockHolder
          ? t(lock.lockedByMe ? 'speleodb.projectListing.lockedByYou' : 'speleodb.projectListing.lockedBy', { email: lock.lockHolder })
          : t(lock.lockHolder === null
            ? 'speleodb.projectListing.unlocked'
            : 'speleodb.projectListing.lockUnknown')}
      </div>
    </div>
  );
}
