import { useTranslation } from 'react-i18next';
import { SpeleoDbLogo } from '../common/SpeleoDbLogo';
import { SpeleoBadgedIcon, HourglassGlyph, PenGlyph } from '../common/SpeleoBadgedIcon';
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
 * "You hold the SpeleoDB write lock": the brightest neutral the theme has, i.e.
 * white on every dark theme and near-black on the four light ones (`light` and
 * `kaleido_eink` are `--cc-panel: #ffffff`, where a literal white bar would not
 * exist). Reusing `--cc-text-primary` rather than a hex keeps the bar visible on all
 * ten themes without adding ten colour values for a human to sign off on.
 */
export const LOCK_MINE_ACCENT = 'var(--cc-text-primary)';

/**
 * "Someone else holds the write lock": blue, the informational register - this is
 * someone else working, not a fault. Deliberately not red (another surveyor holding
 * the lock is the normal state of a shared project, not an error) and not the amber
 * that the hourglass badge uses, which would put two near-identical yellows on this
 * one edge next to `UNPUSHED_ACCENT`.
 *
 * Its own token rather than `--cc-accent`, because the accent is only blue on six of
 * the ten themes - it is teal on `dark` (the default) and `light`, gold on `cave`,
 * violet on `dracula`. Each value is picked against that theme's own panel, border
 * and accent; `dark` needs a bright azure because its panel is navy `#16213e` over a
 * blue `#0f3460` border.
 *
 * On the six themes whose accent IS blue this bar sits near the selection colour.
 * That is inherent - blue is those themes' primary - and is carried by SHAPE: a 3px
 * leading stripe, where selection is a row-wide wash (`bg-accent-10`) or a full card
 * outline (`border-accent ring-accent`).
 *
 * Not the `text-text-tertiary` class used elsewhere in this list: no
 * `--cc-text-tertiary` token or Tailwind entry exists, so that class emits nothing -
 * as a colour it would yield an invalid `box-shadow` the browser drops whole.
 */
export const LOCK_OTHER_ACCENT = 'var(--cc-lock-other)';

/** Which leading-edge accent an entry earns, highest precedence first. */
export type RecentAccent = 'unpushed' | 'lock-mine' | 'lock-other' | 'none';

/**
 * Pick the ONE accent for a recents entry's leading edge.
 *
 * The edge holds a single 3px bar, so the three states have to be ordered rather
 * than stacked, and un-pushed edits outrank lock state: the lock is recoverable
 * (ask, or wait) while work that exists only on this computer is the thing that can
 * actually be lost. Lock state stays legible on a row that loses the bar - the badge
 * and "Write-locked by you / by {email}" in `SpeleoRecentInfo` say it in words.
 *
 * Lock accents are gated on `isRemote` so a local project can never pick one up from
 * a stale holder field.
 */
export function recentAccent(info: SpeleoLockInfo | undefined): RecentAccent {
  if (!info) return 'none';
  if (info.hasLocalEdits) return 'unpushed';
  if (!info.isRemote) return 'none';
  if (info.lockedByMe) return 'lock-mine';
  if (info.lockHolder) return 'lock-other';
  return 'none';
}

const ACCENT_COLOR: Record<Exclude<RecentAccent, 'none'>, string> = {
  unpushed: UNPUSHED_ACCENT,
  'lock-mine': LOCK_MINE_ACCENT,
  'lock-other': LOCK_OTHER_ACCENT,
};

/**
 * The list accent bar down the leading edge of a card / row: yellow for "changes
 * only on this computer" (#270), bright neutral for "you hold the write lock", dim
 * neutral for "someone else does". Deliberately an ACCENT and nothing more - the
 * recents list is a chooser, not a place to shout, so the "!" badge stays on the
 * status button where an action is available. Returns `undefined` (no styling at
 * all) when the entry earns no accent.
 */
export function recentAccentStyle(
  info: SpeleoLockInfo | undefined,
): { boxShadow: string } | undefined {
  const accent = recentAccent(info);
  if (accent === 'none') return undefined;
  return { boxShadow: `inset 3px 0 0 0 ${ACCENT_COLOR[accent]}` };
}

/**
 * Lock-state badge for a recents / GlobalView entry (#201). A local project shows
 * nothing; a SpeleoDB project shows the mark, badged when the scan resolved a
 * holder:
 * - you hold the write lock (green pen - you may edit),
 * - someone else holds it (warning hourglass - you are waiting),
 * - free / not-yet-scanned: the bare mark.
 *
 * The pen rather than a padlock, matching the toolbar status button: the badge
 * answers "what can I do here", and a padlock reads as "shut" to anyone who has
 * not learned that holding the lock is the permissive state.
 */
export function SpeleoLockBadge({
  isRemote,
  lockHolder,
  lockedByMe,
  hasLocalEdits = false,
  size = 18,
  testIdPrefix,
}: {
  isRemote: boolean;
  /** Holder email, `null` = free, `undefined` = not scanned (logged out / offline). */
  lockHolder: string | null | undefined;
  lockedByMe: boolean;
  /** #270: paint the mark yellow - this machine has edits the server does not. */
  hasLocalEdits?: boolean;
  size?: number;
  testIdPrefix: string;
}) {
  const { t } = useTranslation();
  if (!isRemote) return null;
  // The same accent the status button uses, so one yellow means one thing app-wide.
  const tint = hasLocalEdits ? UNPUSHED_ACCENT : undefined;

  if (lockedByMe) {
    return (
      <Tooltip content={t('speleodb.recentBadge.lockedByYou')}>
        <span data-testid={`${testIdPrefix}-badge-locked-me`}>
          <SpeleoBadgedIcon
            badge={<PenGlyph size={10} />}
            badgeColor="text-success"
            size={size}
            tint={tint}
            testIdPrefix={testIdPrefix}
          />
        </span>
      </Tooltip>
    );
  }
  if (lockHolder) {
    return (
      <Tooltip content={t('speleodb.recentBadge.lockedByOther', { email: lockHolder })}>
        <span data-testid={`${testIdPrefix}-badge-locked-other`}>
          <SpeleoBadgedIcon
            badge={<HourglassGlyph />}
            badgeColor="text-warning"
            size={size}
            tint={tint}
            testIdPrefix={testIdPrefix}
          />
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={t('speleodb.recentBadge.remote')}>
      <span data-testid={`${testIdPrefix}-badge-remote`}>
        <SpeleoDbLogo size={size} tint={tint} testId={`${testIdPrefix}-logo`} />
      </span>
    </Tooltip>
  );
}

/**
 * Recents PATH-slot content for a SpeleoDB project (#201). The local file path is
 * irrelevant for a linked project, so in its place we show the SpeleoDB mark plus
 * "SpeleoDB: {name}" - the server-side project name (falling back to the local
 * `name` when the scan hasn't resolved it) - then, when the lock is held, a middot
 * and "Write-locked by you" / "Write-locked by {email}". Returns `null` for a local project
 * (the caller shows the path instead). The last-edited time is not repeated here -
 * it has its own column / card footer.
 */
export function SpeleoRecentInfo({
  info,
  name,
  size = 16,
  testIdPrefix,
}: {
  info: SpeleoLockInfo;
  /** Local project name, used as the label when the SpeleoDB name isn't scanned. */
  name: string;
  size?: number;
  testIdPrefix: string;
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
      data-testid={`${testIdPrefix}-info`}
    >
      <SpeleoLockBadge {...info} size={size} testIdPrefix={testIdPrefix} />
      <span className="truncate">
        {t('speleodb.recentInfo.prefix', { name: info.speleoName ?? name })}
        {/* The middot + lock detail sit a shade back from the project name. */}
        {detail ? <span className="opacity-70"> · {detail}</span> : null}
      </span>
    </span>
  );
}
