import { useTranslation } from 'react-i18next';
import { useSpeleoStore } from '../../store/speleoStore';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoActions } from '../../hooks/useSpeleoActions';
import { permissionAtLeast } from '../../utils/speleoPermission';
import { Button } from '../common/Button';
import { EyeIcon, PencilIcon, CheckCircleIcon, DownloadIcon, LockIcon } from '../common/icons';

/**
 * The linked-project action shell (#204): a persistent read-only/editing
 * indicator plus Start editing / Done / Update controls for a project pulled
 * from SpeleoDB. Renders nothing for a local project (`link === null`). Icons are
 * the app's filled `<Bar>`-primitive glyphs (WebKit stroke-fattening rule).
 *
 * The controls are permission- and lock-gated; the backend edit gate is the real
 * enforcement — this bar is the discoverable surface for the hand-off loop. The
 * #198 divergence prompt and #200 banners plug in through the shared store's
 * `divergence` / `banner` fields (stubbed here).
 */
export function SpeleoEditBar() {
  const { t } = useTranslation();
  const link = useSpeleoStore((s) => s.link);
  const session = useSpeleoStore((s) => s.session);
  const divergence = useSpeleoStore((s) => s.divergence);
  const openDialog = useUIStore((s) => s.openDialog);
  const showToast = useUIStore((s) => s.showToast);
  const { busy, startEditing, update } = useSpeleoActions();

  // Local project (or none open) — the shell is hidden entirely.
  if (!link) return null;

  // #198 seam: a hand-off verb reported divergence. Placeholder until the
  // reconcile prompt lands; the single `divergence` field is the swap point.
  if (divergence) {
    return (
      <div
        className="flex items-center gap-2"
        data-testid="speleo-edit-indicator"
        data-phase="divergence"
      >
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-warning-20 text-warning">
          {t('speleodb.editBar.divergence.label')}
        </span>
        <Button
          size="sm"
          onClick={() => showToast(t('speleodb.editBar.divergence.comingSoon'), 'speleodb-divergence')}
          data-testid="speleo-resolve-divergence"
        >
          {t('speleodb.editBar.divergence.resolve')}
        </Button>
      </div>
    );
  }

  const editing = link.editState === 'editing';
  const canWrite = permissionAtLeast(link.permission, 'READ_AND_WRITE');
  // Someone *else* holds the lock (we compare against our own email).
  const lockedByOther =
    !editing && !!link.lockHolder && link.lockHolder !== session?.userEmail;

  const phase = editing ? 'editing' : lockedByOther ? 'locked' : 'read-only';
  const pillClass = editing
    ? 'bg-accent-10 text-accent'
    : lockedByOther
      ? 'bg-warning-20 text-warning'
      : 'bg-panel border border-border text-text-secondary';
  const pillIcon = editing ? (
    <PencilIcon size={14} />
  ) : lockedByOther ? (
    <LockIcon size={14} />
  ) : (
    <EyeIcon size={14} />
  );
  const pillLabel = editing
    ? t('speleodb.editBar.editing')
    : lockedByOther
      ? t('speleodb.editBar.lockedBy', { email: link.lockHolder })
      : t('speleodb.editBar.readOnly');

  const startEditingTooltip = !canWrite
    ? t('speleodb.editBar.tooltips.readOnlyAccess')
    : lockedByOther
      ? t('speleodb.editBar.tooltips.lockedByOther', { email: link.lockHolder })
      : undefined;

  return (
    <div className="flex items-center gap-2" data-testid="speleo-edit-indicator" data-phase={phase}>
      <span
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${pillClass}`}
        title={pillLabel}
      >
        {pillIcon}
        <span className="max-w-[16rem] truncate">{pillLabel}</span>
        {editing && link.hasUnpushedEdits && (
          <span
            className="ml-0.5 w-1.5 h-1.5 rounded-full bg-accent"
            aria-label={t('speleodb.editBar.unpushed')}
            data-testid="speleo-dirty-dot"
          />
        )}
      </span>

      {editing ? (
        <Button
          size="sm"
          variant="primary"
          icon={<CheckCircleIcon size={14} />}
          disabled={busy}
          onClick={() => openDialog('speleodb-done')}
          data-testid="speleo-done"
        >
          {t('speleodb.editBar.done')}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="primary"
          icon={<PencilIcon size={14} />}
          disabled={busy || !canWrite || lockedByOther}
          title={startEditingTooltip}
          onClick={() => void startEditing()}
          data-testid="speleo-start-editing"
        >
          {t('speleodb.editBar.startEditing')}
        </Button>
      )}

      <Button
        size="sm"
        icon={<DownloadIcon size={14} />}
        disabled={busy}
        onClick={() => void update()}
        data-testid="speleo-update"
      >
        {t('speleodb.editBar.update')}
      </Button>
    </div>
  );
}
