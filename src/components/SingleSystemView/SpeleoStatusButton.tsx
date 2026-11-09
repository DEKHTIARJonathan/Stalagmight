import { LoadingSpinner } from '../common/LoadingSpinner';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSpeleoStore, isUnwoundNotEdited } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoActions } from '../../hooks/useSpeleoActions';
import { useSpeleoMenuItems } from './useSpeleoMenuItems';
import { SpeleoStatusMenu } from './SpeleoStatusMenu';
import { permissionAtLeast } from '../../utils/speleoPermission';
import { UNPUSHED_ACCENT } from '../../utils/speleoLocalState';
import { holdsWriteLock } from '../../utils/quit';
import { LockIcon } from '../common/icons';
import {
  SpeleoBadgedIcon,
  HourglassGlyph,
  RefreshGlyph,
  ExclamationGlyph,
  CrossedPencilGlyph,
  QuestionMarkGlyph,
  EditNoLockGlyph,
  PenGlyph,
} from '../common/SpeleoBadgedIcon';

type ButtonKind =
  | 'unlocked'
  | 'editing'
  | 'force_edit'
  | 'locked_by_other'
  | 'remote_ahead'
  | 'conflict'
  | 'view_only'
  | 'no_permission'
  | 'unknown_error';

/**
 * SpeleoDB project status and its actions menu. Both mouse buttons open the same
 * menu; inspecting status never acquires or releases the project's editing lock.
 * The badge and tint report editing access and changes held only on this computer.
 */
export function SpeleoStatusButton() {
  const { t } = useTranslation();
  const refreshing = useSpeleoStore((s) => s.statusRefreshCount > 0);
  const link = useSpeleoStore((s) => s.link);
  const loggedIn = useSpeleoStore((s) => s.session?.loggedIn ?? false);
  const divergence = useSpeleoStore((s) => s.divergence);
  const appMode = useUIStore((s) => s.appMode);
  const { busy } = useSpeleoActions();
  // The menu's rows - the same array the hamburger's SpeleoDB submenu
  // renders. Held in LOCAL state rather than the `activeDialog` slot: the store-driven
  // ContextMenu is hard-wired to survey-entity targets, and routing through
  // `activeDialog` would evict the very dialogs these rows open.
  const speleoItems = useSpeleoMenuItems();
  const [menuOpen, setMenuOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // The status controls are shown only in Survey mode.
  if (!link || appMode !== 'survey') return null;

  // #270: work that exists ONLY on this computer. This is NOT projectStore.isDirty
  // (unsaved to disk) - it survives a save and a restart, and it is what a lock
  // release or a pull would put at risk. It colours the mark in EVERY state, so the
  // "unlocked" state stops being dirty-blind.
  // [#303] ...unless the ONLY reason it is set is that a chain step walked this copy back
  // to an older version. There is nothing of the user's on this computer then, so tinting
  // the mark "you have work at risk" would describe edits the user never made.
  const unwoundNotEdited = isUnwoundNotEdited(link);
  const unpushed = link.hasUnpushedEdits && !unwoundNotEdited;
  // We hold the server write lock - see `holdsWriteLock` for why force-editing is
  // excluded, and why the predicate is shared rather than re-spelled here.
  const lockHeld = holdsWriteLock(link);
  // Local-only changes with no lock to protect them: the state that most needs
  // calling out, so it gets a second, standalone "!" beside the mark.
  const unpushedUnlocked = unpushed && !lockHeld;
  const tint = unpushed ? UNPUSHED_ACCENT : undefined;
  // Appended to whichever state title applies, so the new dirty variants of the
  // existing states all say the one thing the user needs to know. Left off when we
  // hold the lock: those titles already describe the pending upload.
  const unpushedSuffix = unpushedUnlocked ? ` ${t('speleodb.localEdits.titleSuffix')}` : '';

  // The standalone "!", rendered beside the mark (not on it - the corner badge is
  // the state glyph). Kept out of the accessible name: the title/aria-label below
  // already carries the wording.
  const unpushedBadge = unpushedUnlocked ? (
    <span
      className="ml-0.5 inline-flex items-center"
      style={{ color: UNPUSHED_ACCENT }}
      data-testid="speleodb-status-unpushed-badge"
      aria-hidden="true"
    >
      <ExclamationGlyph size={11} />
    </span>
  ) : null;

  // Logged out: every lock action needs a token (the backend gate would reject the
  // acquire anyway), so present the mark grayed + inert and point the user at login
  // via the tooltip, rather than a live "Start editing" that can only fail (#201).
  //
  // BUT trust an active editing link over a cold frontend session: on reopen the
  // backend rehydrates the token and `refreshLinkStatus` can seed `editState:
  // 'editing'` before `refreshSession` flips `loggedIn` true (both fire unawaited).
  // Showing the inert logged-out mark then would wrongly hide Done/push for a
  // project we actually hold the lock on, so fall through to the normal rendering.
  if (!loggedIn && link.editState !== 'editing') {
    const loggedOutTitle = `${t('speleodb.button.loggedOut')}${unpushedSuffix}`;
    return (
      <button
        type="button"
        disabled
        title={loggedOutTitle}
        aria-label={loggedOutTitle}
        data-testid="speleodb-status-button"
        data-kind="logged_out"
        data-unpushed={unpushed ? 'true' : 'false'}
        className={`flex items-center justify-center h-8 rounded ml-1 opacity-40 cursor-not-allowed ${
          unpushedUnlocked ? 'px-1' : 'w-8'
        }`}
      >
        <SpeleoBadgedIcon
          badge={<LockIcon size={10} />}
          badgeColor="text-text-secondary"
          size={20}
          tint={tint}
          testIdPrefix="speleodb-status-icon"
        />
        {unpushedBadge}
      </button>
    );
  }

  // `editState === 'editing'` is the single source of truth for "we hold the lock
  // and may edit" (the backend enforces hold-lock ⟹ edit-enabled). `lockedByOther`
  // is derived once in the store (a read-only project with a holder is held by
  // another), so a released lock can't still read as ours.
  const lockedByOther = link.lockedByOther;
  const conflict = divergence !== null || link.remoteState === 'conflict';
  // Known view-only grant (WEB_VIEWER / READ_ONLY). A null permission is "unknown"
  // (offline) - treat it as potentially editable and let the backend gate decide,
  // rather than showing a misleading crossed pencil.
  const viewOnly = link.permission !== null && !permissionAtLeast(link.permission, 'READ_AND_WRITE');
  // An unexpected server error (a 404 for a deleted/renamed project, a 5xx, ...) the
  // shell can't otherwise act on - surfaced as a "?" when we are NOT already in a
  // higher-priority definitive state (no-permission / conflict / actively editing),
  // so an active edit session is never overridden by a transient blip (fix 12).
  const serverError = link.serverError !== null;

  const kind: ButtonKind = link.noAccess
    ? 'no_permission'
    : // #213: force-editing (editing WITHOUT the lock) preempts a conflict. The force
      // editor holds no lock, so their way forward is Reconnect (acquire + reconcile),
      // which surfaces any divergence via the resolution dialog; routing them straight
      // to the divergence dialog (as 'conflict' does) would offer push / take-remote
      // actions that assume a held lock. This also keeps the button in agreement with
      // SpeleoBanner, which shows the force-edit banner ahead of a conflict.
      link.editState === 'editing' && link.forceEditing
      ? 'force_edit'
      : conflict
        ? 'conflict'
        : link.editState === 'editing'
          ? 'editing'
          : serverError
          ? 'unknown_error'
          : lockedByOther
            ? 'locked_by_other'
            : viewOnly
              ? 'view_only'
              : link.remoteState === 'remote_ahead'
                ? 'remote_ahead'
                : 'unlocked';

  // The indicator reports state; changing the lock requires an explicit menu action.
  const glyph =
    kind === 'unlocked' ? null : kind === 'editing' ? (
      <PenGlyph size={11} />
    ) : kind === 'force_edit' ? (
      <EditNoLockGlyph size={12} />
    ) : kind === 'locked_by_other' ? (
      <HourglassGlyph size={10} />
    ) : kind === 'view_only' ? (
      <CrossedPencilGlyph size={12} />
    ) : kind === 'remote_ahead' ? (
      <RefreshGlyph size={12} />
    ) : kind === 'unknown_error' ? (
      <QuestionMarkGlyph size={11} />
    ) : (
      <ExclamationGlyph size={11} />
    );

  const glyphColor =
    kind === 'unlocked'
      ? undefined
      : kind === 'editing'
        ? 'text-green-400'
        : kind === 'force_edit'
          ? 'text-red-500'
          : kind === 'locked_by_other'
          ? 'text-orange-400'
          : kind === 'view_only'
            ? 'text-text-secondary'
            : kind === 'remote_ahead'
              ? 'text-blue-400'
              : kind === 'unknown_error'
                ? 'text-yellow-400'
                : 'text-red-500';

  // Hover background tint tracks the badge colour (conflict + no-permission keep a
  // persistent red; the rest are transparent with a coloured hover).
  const bgClass =
    kind === 'conflict' || kind === 'no_permission'
      ? 'bg-red-900 hover:bg-red-800'
      : kind === 'force_edit'
        ? // A persistent faint-red tint so the danger reads even without hover (the
          // full warning lives in the banner); distinct from conflict's solid red.
          'bg-red-500/10 hover:bg-red-500/20'
        : kind === 'editing'
          ? 'hover:bg-green-400/20'
          : kind === 'locked_by_other'
          ? 'hover:bg-orange-400/20'
          : kind === 'view_only'
            ? 'hover:bg-white/10'
            : kind === 'remote_ahead'
              ? 'hover:bg-blue-400/20'
              : kind === 'unknown_error'
                ? 'hover:bg-yellow-400/20'
                : 'hover:bg-yellow-400/20';

  const title =
    kind === 'unlocked'
      ? t('speleodb.button.unlocked')
      : kind === 'editing'
        ? // An unwound copy is an older version, not new edits waiting to upload.
          unwoundNotEdited
          ? t('speleodb.button.editingUnwound')
          : link.hasUnpushedEdits
            ? t('speleodb.button.editingDirty')
            : t('speleodb.button.editingClean')
        : kind === 'force_edit'
          ? link.lockedByOther
            ? t('speleodb.button.forceEditingLockedBy', {
                email: link.lockHolder ?? t('speleodb.editBar.someone'),
              })
            : t('speleodb.button.forceEditing')
          : kind === 'locked_by_other'
          ? t('speleodb.button.lockedByOther', { email: link.lockHolder })
          : kind === 'view_only'
            ? t('speleodb.button.viewOnly')
            : kind === 'remote_ahead'
              ? t('speleodb.button.remoteAhead')
              : kind === 'no_permission'
                ? t('speleodb.button.noPermission')
                : kind === 'unknown_error'
                  ? t('speleodb.button.unknownError')
                  : t('speleodb.button.conflict');

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        // Known limitation: `onContextMenu` never fires on a DISABLED button, so
        // right-click is inert while `busy` and in the logged-out branch above.
        // Both are states in which every row of the menu would be disabled anyway,
        // so there is nothing to reach.
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={`${title}${unpushedSuffix}`}
        aria-label={`${title}${unpushedSuffix}`}
        data-testid="speleodb-status-button"
        data-kind={kind}
        data-unpushed={unpushed ? 'true' : 'false'}
        className={`flex items-center justify-center h-8 rounded ml-1 transition-colors disabled:opacity-50 ${
          unpushedUnlocked ? 'px-1' : 'w-8'
        } ${bgClass}`}
      >
        {/* The state badge sits on the ICON - a small disc + glyph anchored to the
            logo's corner (like the DisplayMenu shot/station symbols), not floating
            on the button. The MARK itself turns yellow while there are un-pushed
            local edits (#270). */}
        {busy || refreshing ? (
          <span role="status" aria-label={t('common.states.loading')}>
            <LoadingSpinner testId="speleodb-status-spinner" />
          </span>
        ) : (
        <SpeleoBadgedIcon
          badge={glyph}
          badgeColor={glyphColor}
          size={20}
          tint={tint}
          testIdPrefix="speleodb-status-icon"
        />
        )}
        {unpushedBadge}
      </button>
      {menuOpen && (
        <SpeleoStatusMenu
          items={speleoItems}
          triggerRef={buttonRef}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </>
  );
}
