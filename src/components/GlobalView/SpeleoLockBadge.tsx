import { useTranslation } from 'react-i18next';
import { SpeleoDbLogo } from '../common/SpeleoDbLogo';
import { SpeleoBadgedIcon, HourglassGlyph } from '../common/SpeleoBadgedIcon';
import { Tooltip } from '../common';

/** Resolved lock state for one recents entry, from the login/app-open scan (#201). */
export interface SpeleoLockInfo {
  isRemote: boolean;
  /** Holder email, `null` = free, `undefined` = not scanned (logged out / offline). */
  lockHolder: string | null | undefined;
  lockedByMe: boolean;
}

/**
 * Resolve a recents entry's SpeleoDB lock state by matching its linked project id
 * against the scan's `remoteLocks` map (#201). A local project (or one with no
 * project id) is `{ isRemote: false }`; a remote one carries its holder (or
 * `undefined` when the scan hasn't run).
 */
export function resolveSpeleoLock(
  project: { is_remote: boolean; speleodb_project_id?: string | null },
  remoteLocks: Record<string, string | null>,
  myEmail: string | null,
): SpeleoLockInfo {
  const pid = project.speleodb_project_id ?? undefined;
  const lockHolder = pid !== undefined && pid in remoteLocks ? remoteLocks[pid] : undefined;
  const lockedByMe = !!(
    lockHolder &&
    myEmail &&
    lockHolder.toLowerCase() === myEmail.toLowerCase()
  );
  return { isRemote: project.is_remote, lockHolder, lockedByMe };
}

/** Small filled padlock glyph (drawn FILLED, not stroked - WebKit fattens strokes
    under the UI zoom, invisible in Chromium/Playwright). */
function LockGlyph({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M5 7V5a3 3 0 016 0v2h1v7H4V7h1zm1.5 0h3V5a1.5 1.5 0 00-3 0v2z" />
    </svg>
  );
}

/**
 * Lock-state badge for a recents / GlobalView entry (#201). A local project shows
 * nothing; a SpeleoDB project shows the mark, with a lock glyph overlaid when the
 * scan resolved a holder:
 * - locked by you (green padlock),
 * - locked by another (warning hourglass),
 * - free / not-yet-scanned: the bare mark.
 */
export function SpeleoLockBadge({
  isRemote,
  lockHolder,
  lockedByMe,
  size = 18,
}: {
  isRemote: boolean;
  /** Holder email, `null` = free, `undefined` = not scanned (logged out / offline). */
  lockHolder: string | null | undefined;
  lockedByMe: boolean;
  size?: number;
}) {
  const { t } = useTranslation();
  if (!isRemote) return null;

  if (lockedByMe) {
    return (
      <Tooltip content={t('speleodb.recentBadge.lockedByYou')}>
        <span data-testid="speleo-recent-badge-locked-me">
          <SpeleoBadgedIcon badge={<LockGlyph />} badgeColor="text-success" size={size} />
        </span>
      </Tooltip>
    );
  }
  if (lockHolder) {
    return (
      <Tooltip content={t('speleodb.recentBadge.lockedByOther', { email: lockHolder })}>
        <span data-testid="speleo-recent-badge-locked-other">
          <SpeleoBadgedIcon badge={<HourglassGlyph />} badgeColor="text-warning" size={size} />
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={t('speleodb.recentBadge.remote')}>
      <span data-testid="speleo-recent-badge-remote">
        <SpeleoDbLogo size={size} />
      </span>
    </Tooltip>
  );
}
