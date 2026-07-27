import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSpeleoStore } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoActions } from '../../hooks/useSpeleoActions';
import { useSpeleoMenuItems } from './useSpeleoMenuItems';
import { SpeleoStatusMenu } from './SpeleoStatusMenu';
import { permissionAtLeast } from '../../utils/speleoPermission';
import { MIN_POLL_INTERVAL_SECONDS, MAX_POLL_INTERVAL_SECONDS } from '../../types/config';
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
 * The single SpeleoDB status button (T2c), mounted right of the hamburger when a
 * remote project is open. The white logo carries a state glyph + color; one click
 * drives the hand-off:
 * - (no badge) read-only, up to date - the resting state → acquire the write lock
 *   (Start editing). Bare on purpose: nothing is wrong and nothing is held, so it
 *   is the one state with nothing to announce.
 * - 🟢 pen (we hold the write lock) → release; if dirty, the push&release dialog
 * - 🟥 crossed-pencil on faint red (force-editing WITHOUT the lock, #213) → Reconnect
 * - 🟠 hourglass (someone else holds it) → pull the latest; if dirty, resolve
 * - 🔵 pull (remote advanced) → pull the latest; if dirty, resolve
 * - ✏️̸ crossed pencil (read-only / web-viewer permission) → refresh the .stalx
 * - 🟥 crimson (conflict) → the resolution dialog (#198)
 * - ❗ red exclamation (no permission - shared as a file) → offer converting to a
 *   plain unmanaged .stalx (fix 10)
 *
 * Across ALL of those states (#270) the mark itself turns from white to yellow
 * whenever the project has edits that are not on SpeleoDB, and gains a standalone
 * yellow "!" when those edits are not even protected by a held lock - which is what
 * makes the "unlocked" state stop being dirty-blind.
 *
 * A RIGHT-click opens the hamburger's SpeleoDB submenu against the button instead
 * (`SpeleoStatusMenu`), so every hand-off verb is reachable from the indicator that
 * reports the state, not only the one the left click happens to be wired to.
 *
 * It also owns the remote-state poll (configurable interval, clamped 30s..24h)
 * while a remote project is open.
 */
export function SpeleoStatusButton() {
  const { t } = useTranslation();
  const link = useSpeleoStore((s) => s.link);
  const loggedIn = useSpeleoStore((s) => s.session?.loggedIn ?? false);
  const divergence = useSpeleoStore((s) => s.divergence);
  const pollNonce = useSpeleoStore((s) => s.pollNonce);
  const refreshLinkStatus = useSpeleoStore((s) => s.refreshLinkStatus);
  const openDialog = useUIStore((s) => s.openDialog);
  const appMode = useUIStore((s) => s.appMode);
  // Optional-chain `speleodb` too: the config is loaded async, so a render can land
  // before it arrives (or with an older-shaped config that predates the speleodb
  // block) - reading `.poll_interval_seconds` off an undefined `speleodb` would throw
  // and crash the whole SingleSystemView on mount. Fall back to the 60s default.
  const pollInterval = useProjectStore((s) => s.config?.speleodb?.poll_interval_seconds ?? 60);
  const { busy, startEditing, update, done } = useSpeleoActions();
  // The right-click menu's rows - the same array the hamburger's SpeleoDB submenu
  // renders. Held in LOCAL state rather than the `activeDialog` slot: the store-driven
  // ContextMenu is hard-wired to survey-entity targets, and routing through
  // `activeDialog` would evict the very dialogs these rows open.
  const speleoItems = useSpeleoMenuItems();
  const [menuOpen, setMenuOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const isRemote = link !== null;

  // Poll the remote state on the configured interval while the button is actually
  // SHOWN - a remote project open in Survey mode with the window visible (T2c
  // freshness). Clamped 30s (backend floor) .. 24h (fix 14). Gated on `appMode` +
  // `document.hidden` so we don't spend server round trips on an indicator nobody
  // can see in Plan/Export or a backgrounded window (fix 15). Depends on pollNonce
  // so a just-issued hand-off verb restarts the timer - the next poll is then a full
  // interval past a lock change the server may not yet reflect (1b).
  useEffect(() => {
    if (!isRemote || appMode !== 'survey') return undefined;
    const seconds = Math.min(
      MAX_POLL_INTERVAL_SECONDS,
      Math.max(MIN_POLL_INTERVAL_SECONDS, pollInterval),
    );
    const id = setInterval(() => {
      // Skip the round trip while the window is hidden (minimized / another app);
      // the timer stays armed so polling resumes on the next visible tick.
      if (!document.hidden) void refreshLinkStatus();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [isRemote, appMode, pollInterval, refreshLinkStatus, pollNonce]);

  // Only in Survey mode - Plan/Export are non-editing views, so the hand-off
  // button + read-only badge are hidden there. The poll above is torn down in those
  // modes (its effect early-returns on non-Survey, clearing the interval) and
  // re-armed on return to Survey; the first poll is then up to one interval out, so
  // a status change that landed while away surfaces on the next tick.
  if (!link || appMode !== 'survey') return null;

  // #270: work that exists ONLY on this computer. This is NOT projectStore.isDirty
  // (unsaved to disk) - it survives a save and a restart, and it is what a lock
  // release or a pull would put at risk. It colours the mark in EVERY state, so the
  // "unlocked" state stops being dirty-blind.
  const unpushed = link.hasUnpushedEdits;
  // We hold the server write lock - see `holdsWriteLock` for why force-editing is
  // excluded, and why the predicate is shared rather than re-spelled here.
  const lockHeld = holdsWriteLock(link);
  // Local-only changes with no lock to protect them: the state that most needs
  // calling out, so it gets a second, standalone "!" beside the mark.
  const unpushedUnlocked = unpushed && !lockHeld;
  const tint = unpushed ? UNPUSHED_ACCENT : undefined;
  // Appended to whichever state title applies, so the new dirty variants of the
  // existing states all say the one thing the user needs to know. Left off when we
  // hold the lock: those titles already talk about pushing.
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

  const handleClick = () => {
    switch (kind) {
      case 'unlocked':
        void startEditing();
        break;
      case 'editing':
        // Release; push & release via the dialog when there are local changes.
        if (link.hasUnpushedEdits) openDialog('speleodb-done');
        else void done(null);
        break;
      case 'force_edit':
        // We hold no lock, so the action is Reconnect (acquire + reconcile). If the
        // acquire finds divergence it reports it and the App effect opens the
        // resolution dialog; if someone else holds it, it reports "locked by {email}".
        void startEditing();
        break;
      case 'locked_by_other':
        // Try to take the lock - the acquire fails while someone else holds it and
        // reports "unable to lock - being edited by {email}", or succeeds if they've
        // since released it.
        void startEditing();
        break;
      case 'view_only':
        // Read-only access: the only meaningful action is pulling the latest.
        void update();
        break;
      case 'remote_ahead':
        // Pull the latest; hand off to the resolution dialog if we'd clobber edits.
        if (link.hasUnpushedEdits) openDialog('speleodb-divergence');
        else void update();
        break;
      case 'conflict':
        openDialog('speleodb-divergence');
        break;
      case 'no_permission':
        // No access on the server - offer converting to a plain local .stalx.
        openDialog('speleodb-no-permission');
        break;
      case 'unknown_error':
        // Nothing to act on - just surface what SpeleoDB actually said (a deleted
        // project, a 5xx, ...) in the generic error dialog (fix 12).
        openDialog('error', {
          title: t('speleodb.serverError.title'),
          message: link.serverError?.message ?? t('speleodb.serverError.fallback'),
          hideReportHint: true,
        });
        break;
    }
  };

  // `unlocked` gets NO badge: it is the resting state of a remote project - nothing
  // is wrong, nothing is held, nothing needs doing - and decorating it spent the
  // badge slot on the one case that has nothing to say. The tooltip still offers
  // "click to start editing", and the #270 yellow tint still calls out un-pushed
  // work, so the two things worth noticing keep their signal.
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
        ? link.hasUnpushedEdits
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
        onClick={handleClick}
        // Known limitation: `onContextMenu` never fires on a DISABLED button, so
        // right-click is inert while `busy` and in the logged-out branch above.
        // Both are states in which every row of the menu would be disabled anyway,
        // so there is nothing to reach.
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
        disabled={busy}
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
        <SpeleoBadgedIcon badge={glyph} badgeColor={glyphColor} size={20} tint={tint} />
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
