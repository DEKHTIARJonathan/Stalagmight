import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSpeleoStore } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { useSpeleoActions } from '../../hooks/useSpeleoActions';
import { SpeleoDbLogo } from '../common/SpeleoDbLogo';
import { LockIcon, PencilIcon, AlertTriangleIcon } from '../common/icons';

const MIN_POLL_INTERVAL_SECONDS = 30;

/** Filled hourglass glyph (someone else is editing). */
function HourglassGlyph({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4 2h8v3L8 8 4 5V2zM4 14h8v-3L8 8l-4 3v3z" />
    </svg>
  );
}

/** Filled pull-down arrow glyph (remote has an update to pull). */
function PullGlyph({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M6 2h4v6h3l-5 6-5-6h3V2z" />
    </svg>
  );
}

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

  if (!link) return null;

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
      <PullGlyph size={10} />
    ) : (
      <AlertTriangleIcon size={10} />
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
            : 'text-red-200';

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
      className={`flex items-center justify-center w-8 h-8 rounded ml-1 transition-opacity disabled:opacity-50 ${
        kind === 'conflict' ? 'bg-red-900 hover:bg-red-800' : 'bg-slate-700 hover:bg-slate-600'
      }`}
    >
      {/* The state badge sits on the ICON — a small disc + glyph anchored to the
          logo's corner (like the DisplayMenu shot/station symbols), not floating
          on the button. */}
      <span className="relative inline-flex">
        <SpeleoDbLogo size={20} />
        <span
          className={`absolute -bottom-1 -right-1 flex items-center justify-center rounded-full bg-slate-900 p-[1px] ${glyphColor}`}
          data-testid="speleodb-status-badge"
        >
          {glyph}
        </span>
      </span>
    </button>
  );
}
