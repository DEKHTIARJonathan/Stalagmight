import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSpeleoStore } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoActions } from '../../hooks/useSpeleoActions';
import { LockIcon, PencilIcon } from '../common/icons';
import {
  SpeleoBadgedIcon,
  HourglassGlyph,
  RefreshGlyph,
  ExclamationGlyph,
} from '../common/SpeleoBadgedIcon';

const MIN_POLL_INTERVAL_SECONDS = 30;

type ButtonKind = 'unlocked' | 'editing' | 'locked_by_other' | 'remote_ahead' | 'conflict';

/**
 * The single SpeleoDB status button (T2c), mounted right of the hamburger when a
 * remote project is open. The white logo carries a state glyph + color; one click
 * drives the hand-off:
 * - 🟡 pencil (read-only, up to date) → acquire the lock (Start editing)
 * - 🟢 lock (we hold it) → release; if dirty, the push&release dialog
 * - 🟠 hourglass (someone else holds it) → pull the latest; if dirty, resolve
 * - 🔵 pull (remote advanced) → pull the latest; if dirty, resolve
 * - 🟥 crimson (conflict) → the resolution dialog (#198)
 *
 * It also owns the remote-state poll (configurable interval, floor 30s) while a
 * remote project is open.
 */
export function SpeleoStatusButton() {
  const { t } = useTranslation();
  const link = useSpeleoStore((s) => s.link);
  const session = useSpeleoStore((s) => s.session);
  const divergence = useSpeleoStore((s) => s.divergence);
  const refreshLinkStatus = useSpeleoStore((s) => s.refreshLinkStatus);
  const openDialog = useUIStore((s) => s.openDialog);
  const appMode = useUIStore((s) => s.appMode);
  const pollInterval = useProjectStore((s) => s.config?.speleodb.poll_interval_seconds ?? 60);
  const { busy, startEditing, update, done } = useSpeleoActions();

  const isRemote = link !== null;

  // Poll the remote state on the configured interval while a remote project is
  // open (T2c freshness). Floored at 30s to match the backend clamp.
  useEffect(() => {
    if (!isRemote) return undefined;
    const ms = Math.max(MIN_POLL_INTERVAL_SECONDS, pollInterval) * 1000;
    const id = setInterval(() => void refreshLinkStatus(), ms);
    return () => clearInterval(id);
  }, [isRemote, pollInterval, refreshLinkStatus]);

  // Only in Survey mode — Plan/Export are non-editing views, so the hand-off
  // button + read-only badge are hidden there. Polling above keeps running so the
  // state is fresh when you return to Survey.
  if (!link || appMode !== 'survey') return null;

  const myEmail = session?.userEmail ?? null;
  const lockedByOther = !!link.lockHolder && link.lockHolder !== myEmail;
  const conflict = divergence !== null || link.remoteState === 'conflict';

  const kind: ButtonKind = conflict
    ? 'conflict'
    : link.editState === 'editing'
      ? 'editing'
      : lockedByOther
        ? 'locked_by_other'
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
      case 'remote_ahead':
        // Pull the latest; hand off to the resolution dialog if we'd clobber edits.
        if (link.hasUnpushedEdits) openDialog('speleodb-divergence');
        else void update();
        break;
      case 'conflict':
        openDialog('speleodb-divergence');
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
          : kind === 'remote_ahead'
            ? 'text-blue-400'
            : 'text-red-500';

  // Hover background tint tracks the badge colour (conflict keeps its persistent
  // crimson; the rest are transparent with a coloured hover).
  const bgClass =
    kind === 'conflict'
      ? 'bg-red-900 hover:bg-red-800'
      : kind === 'editing'
        ? 'hover:bg-green-400/20'
        : kind === 'locked_by_other'
          ? 'hover:bg-orange-400/20'
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
          : kind === 'remote_ahead'
            ? t('speleodb.button.remoteAhead')
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
