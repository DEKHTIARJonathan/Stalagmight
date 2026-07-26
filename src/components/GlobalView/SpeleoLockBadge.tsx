import { useTranslation } from 'react-i18next';
import { SpeleoDbLogo } from '../common/SpeleoDbLogo';
import { SpeleoBadgedIcon, HourglassGlyph } from '../common/SpeleoBadgedIcon';
import { Tooltip } from '../common';
import { emailsMatch } from '../../utils/email';
import {
  hasUnpushedEdits,
  UNPUSHED_ACCENT,
  type SpeleoLocalStateMap,
} from '../../utils/speleoLocalState';

/** Resolved lock state for one recents entry, from the login/app-open scan (#201). */
export interface SpeleoLockInfo {
  isRemote: boolean;
  /** Holder email, `null` = free, `undefined` = not scanned (logged out / offline). */
  lockHolder: string | null | undefined;
  lockedByMe: boolean;
  /** The SpeleoDB project's server-side name, if the scan resolved it (`undefined`
      when logged out / offline / not scanned). May differ from the local name. */
  speleoName: string | undefined;
  /** #270: this machine holds edits the server does not have. False when the local
      state was not fetched, or the fetch failed - it is never a claim of "clean". */
  hasLocalEdits: boolean;
}

/**
 * Resolve a recents entry's SpeleoDB lock state by matching its linked project id
 * against the scan's `remoteLocks` / `remoteProjects` maps (#201). A local project
 * (or one with no project id) is `{ isRemote: false }`; a remote one carries its
 * holder + SpeleoDB name (or `undefined` when the scan hasn't run).
 *
 * `localStates` (#270) is the purely-local half of the join - the server scans
 * cannot know whether a project has work that was never pushed - fetched once for
 * the whole list. Omitted / empty simply yields `hasLocalEdits: false`, i.e. no
 * accent, which is the graceful degradation when that call fails.
 */
export function resolveSpeleoLock(
  project: { is_remote: boolean; speleodb_project_id?: string | null },
  remoteLocks: Record<string, string | null>,
  myEmail: string | null,
  remoteProjects: Record<string, string> = {},
  localStates: SpeleoLocalStateMap = {},
): SpeleoLockInfo {
  const pid = project.speleodb_project_id ?? undefined;
  const lockHolder = pid !== undefined && pid in remoteLocks ? remoteLocks[pid] : undefined;
  const speleoName = pid !== undefined ? remoteProjects[pid] : undefined;
  // Shared ownership check (see emailsMatch): keeps this badge in step with the
  // held-lock prompt's own derivation off the same scan.
  const lockedByMe = emailsMatch(lockHolder, myEmail);
  return {
    isRemote: project.is_remote,
    lockHolder,
    lockedByMe,
    speleoName,
    hasLocalEdits: hasUnpushedEdits(localStates, pid),
  };
}

/**
 * The list accent for "this project has changes only on this computer" (#270): a
 * yellow bar down the leading edge of the card / row. Deliberately an ACCENT and
 * nothing more - the recents list is a chooser, not a place to shout, so the "!"
 * badge stays on the status button where an action is available. Returns `undefined`
 * (no styling at all) for a project with no local edits.
 */
export function unpushedAccentStyle(hasLocalEdits: boolean): { boxShadow: string } | undefined {
  return hasLocalEdits ? { boxShadow: `inset 3px 0 0 0 ${UNPUSHED_ACCENT}` } : undefined;
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
  hasLocalEdits = false,
  size = 18,
}: {
  isRemote: boolean;
  /** Holder email, `null` = free, `undefined` = not scanned (logged out / offline). */
  lockHolder: string | null | undefined;
  lockedByMe: boolean;
  /** #270: paint the mark yellow - this machine has edits the server does not. */
  hasLocalEdits?: boolean;
  size?: number;
}) {
  const { t } = useTranslation();
  if (!isRemote) return null;
  // The same accent the status button uses, so one yellow means one thing app-wide.
  const tint = hasLocalEdits ? UNPUSHED_ACCENT : undefined;

  if (lockedByMe) {
    return (
      <Tooltip content={t('speleodb.recentBadge.lockedByYou')}>
        <span data-testid="speleo-recent-badge-locked-me">
          <SpeleoBadgedIcon badge={<LockGlyph />} badgeColor="text-success" size={size} tint={tint} />
        </span>
      </Tooltip>
    );
  }
  if (lockHolder) {
    return (
      <Tooltip content={t('speleodb.recentBadge.lockedByOther', { email: lockHolder })}>
        <span data-testid="speleo-recent-badge-locked-other">
          <SpeleoBadgedIcon badge={<HourglassGlyph />} badgeColor="text-warning" size={size} tint={tint} />
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={t('speleodb.recentBadge.remote')}>
      <span data-testid="speleo-recent-badge-remote">
        <SpeleoDbLogo size={size} tint={tint} />
      </span>
    </Tooltip>
  );
}

/**
 * Recents PATH-slot content for a SpeleoDB project (#201). The local file path is
 * irrelevant for a linked project, so in its place we show the SpeleoDB mark plus
 * "SpeleoDB: {name}" - the server-side project name (falling back to the local
 * `name` when the scan hasn't resolved it) - then, when the lock is held, a middot
 * and "Locked by you" / "Locked by {email}". Returns `null` for a local project
 * (the caller shows the path instead). The last-edited time is not repeated here -
 * it has its own column / card footer.
 */
export function SpeleoRecentInfo({
  info,
  name,
  size = 16,
}: {
  info: SpeleoLockInfo;
  /** Local project name, used as the label when the SpeleoDB name isn't scanned. */
  name: string;
  size?: number;
}) {
  const { t } = useTranslation();
  if (!info.isRemote) return null;
  const detail = info.lockedByMe
    ? t('speleodb.recentInfo.lockedByYou')
    : info.lockHolder
      ? t('speleodb.recentInfo.lockedByOther', { email: info.lockHolder })
      : null;
  return (
    <span
      className="inline-flex items-center gap-1.5 min-w-0 text-xs text-text-tertiary"
      data-testid="speleo-recent-info"
    >
      <SpeleoLockBadge {...info} size={size} />
      <span className="truncate">
        {t('speleodb.recentInfo.prefix', { name: info.speleoName ?? name })}
        {/* The middot + lock detail sit a shade back from the project name. */}
        {detail ? <span className="opacity-70"> · {detail}</span> : null}
      </span>
    </span>
  );
}
