import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSpeleoStore } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoActions } from '../../hooks/useSpeleoActions';
import { permissionAtLeast } from '../../utils/speleoPermission';
import { LockIcon, PencilIcon } from '../common/icons';
import {
  SpeleoBadgedIcon,
  HourglassGlyph,
  RefreshGlyph,
  ExclamationGlyph,
  CrossedPencilGlyph,
} from '../common/SpeleoBadgedIcon';

const MIN_POLL_INTERVAL_SECONDS = 30;
// Cap the poll interval so a huge configured value can't effectively disable the
// freshness poll (fix 14). setInterval also overflows its 32-bit delay past ~24.8
// days and would fire immediately; 24h stays well clear.
const MAX_POLL_INTERVAL_SECONDS = 24 * 60 * 60;

type ButtonKind =
  | 'unlocked'
  | 'editing'
  | 'locked_by_other'
  | 'remote_ahead'
  | 'conflict'
  | 'view_only'
  | 'no_permission';

/**
 * The single SpeleoDB status button (T2c), mounted right of the hamburger when a
 * remote project is open. The white logo carries a state glyph + color; one click
 * drives the hand-off:
 * - 🟡 pencil (read-only, up to date) → acquire the lock (Start editing)
 * - 🟢 lock (we hold it) → release; if dirty, the push&release dialog
 * - 🟠 hourglass (someone else holds it) → pull the latest; if dirty, resolve
 * - 🔵 pull (remote advanced) → pull the latest; if dirty, resolve
 * - ✏️̸ crossed pencil (read-only / web-viewer permission) → refresh the .stalx
 * - 🟥 crimson (conflict) → the resolution dialog (#198)
 * - ❗ red exclamation (no permission — shared as a file) → offer converting to a
 *   plain unmanaged .stalx (fix 10)
 *
 * It also owns the remote-state poll (configurable interval, clamped 30s..24h)
 * while a remote project is open.
 */
export function SpeleoStatusButton() {
  const { t } = useTranslation();
  const link = useSpeleoStore((s) => s.link);
  const divergence = useSpeleoStore((s) => s.divergence);
  const pollNonce = useSpeleoStore((s) => s.pollNonce);
  const refreshLinkStatus = useSpeleoStore((s) => s.refreshLinkStatus);
  const openDialog = useUIStore((s) => s.openDialog);
  const appMode = useUIStore((s) => s.appMode);
  const pollInterval = useProjectStore((s) => s.config?.speleodb.poll_interval_seconds ?? 60);
  const { busy, startEditing, update, done } = useSpeleoActions();

  const isRemote = link !== null;

  // Poll the remote state on the configured interval while a remote project is
  // open (T2c freshness). Clamped 30s (backend floor) .. 24h (fix 14). Depends on
  // pollNonce so a just-issued hand-off verb restarts the timer — the next poll is
  // then a full interval past a lock change the server may not yet reflect (1b).
  useEffect(() => {
    if (!isRemote) return undefined;
    const seconds = Math.min(
      MAX_POLL_INTERVAL_SECONDS,
      Math.max(MIN_POLL_INTERVAL_SECONDS, pollInterval),
    );
    const id = setInterval(() => void refreshLinkStatus(), seconds * 1000);
    return () => clearInterval(id);
  }, [isRemote, pollInterval, refreshLinkStatus, pollNonce]);

  // Only in Survey mode — Plan/Export are non-editing views, so the hand-off
  // button + read-only badge are hidden there. Polling above keeps running so the
  // state is fresh when you return to Survey.
  if (!link || appMode !== 'survey') return null;

  // `editState === 'editing'` is the single source of truth for "we hold the lock
  // and may edit" (the backend enforces hold-lock ⟹ edit-enabled). `lockedByOther`
  // is derived once in the store (a read-only project with a holder is held by
  // another), so a released lock can't still read as ours.
  const lockedByOther = link.lockedByOther;
  const conflict = divergence !== null || link.remoteState === 'conflict';
  // Known view-only grant (WEB_VIEWER / READ_ONLY). A null permission is "unknown"
  // (offline) — treat it as potentially editable and let the backend gate decide,
  // rather than showing a misleading crossed pencil.
  const viewOnly = link.permission !== null && !permissionAtLeast(link.permission, 'READ_AND_WRITE');

  const kind: ButtonKind = link.noAccess
    ? 'no_permission'
    : conflict
      ? 'conflict'
      : link.editState === 'editing'
        ? 'editing'
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
      case 'locked_by_other':
        // Try to take the lock — the acquire fails while someone else holds it and
        // reports "unable to lock — being edited by {email}", or succeeds if they've
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
        // No access on the server — offer converting to a plain local .stalx.
        openDialog('speleodb-no-permission');
        break;
    }
  };

  const glyph =
    kind === 'unlocked' ? (
      <PencilIcon size={10} />
    ) : kind === 'editing' ? (
      <LockIcon size={10} />
    ) : kind === 'locked_by_other' ? (
      <HourglassGlyph size={10} />
    ) : kind === 'view_only' ? (
      <CrossedPencilGlyph size={12} />
    ) : kind === 'remote_ahead' ? (
      <RefreshGlyph size={12} />
    ) : (
      <ExclamationGlyph size={11} />
    );

  const glyphColor =
    kind === 'unlocked'
      ? 'text-yellow-400'
      : kind === 'editing'
        ? 'text-green-400'
        : kind === 'locked_by_other'
          ? 'text-orange-400'
          : kind === 'view_only'
            ? 'text-text-secondary'
            : kind === 'remote_ahead'
              ? 'text-blue-400'
              : 'text-red-500';

  // Hover background tint tracks the badge colour (conflict + no-permission keep a
  // persistent red; the rest are transparent with a coloured hover).
  const bgClass =
    kind === 'conflict' || kind === 'no_permission'
      ? 'bg-red-900 hover:bg-red-800'
      : kind === 'editing'
        ? 'hover:bg-green-400/20'
        : kind === 'locked_by_other'
          ? 'hover:bg-orange-400/20'
          : kind === 'view_only'
            ? 'hover:bg-white/10'
            : kind === 'remote_ahead'
              ? 'hover:bg-blue-400/20'
              : 'hover:bg-yellow-400/20';

  const title =
    kind === 'unlocked'
      ? t('speleodb.button.unlocked')
      : kind === 'editing'
        ? link.hasUnpushedEdits
          ? t('speleodb.button.editingDirty')
          : t('speleodb.button.editingClean')
        : kind === 'locked_by_other'
          ? t('speleodb.button.lockedByOther', { email: link.lockHolder })
          : kind === 'view_only'
            ? t('speleodb.button.viewOnly')
            : kind === 'remote_ahead'
              ? t('speleodb.button.remoteAhead')
              : kind === 'no_permission'
                ? t('speleodb.button.noPermission')
                : t('speleodb.button.conflict');

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      title={title}
      aria-label={title}
      data-testid="speleodb-status-button"
      data-kind={kind}
      className={`flex items-center justify-center w-8 h-8 rounded ml-1 transition-colors disabled:opacity-50 ${bgClass}`}
    >
      {/* The state badge sits on the ICON — a small disc + glyph anchored to the
          logo's corner (like the DisplayMenu shot/station symbols), not floating
          on the button. */}
      <SpeleoBadgedIcon badge={glyph} badgeColor={glyphColor} size={20} />
    </button>
  );
}
