import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../common/Button';
import { useSpeleoStore } from '../../../store/speleoStore';
import { humanizeSpeleoError } from '../../../utils/speleoError';
import { holdsWriteLock } from '../../../utils/quit';
import type { UndoMode } from '../../../types/ipc.generated';

/**
 * [#303] The open SpeleoDB project's undo-history policy: Full (each revision stores the
 * operations that produced it, so undo chains back through the project's history) or
 * Disabled (undo works locally but is stripped before every push).
 *
 * It lives in this dialog rather than in the application Settings because it is a
 * PROJECT setting: the value is written into the `.stalx` and rides to the server on the
 * next push, so it becomes the policy for everyone who edits the project. That is also
 * why it needs the write lock - the same gate every other edit to the project file goes
 * through - and why the control says so instead of just being greyed out.
 *
 * The panel around it edits SERVER-side metadata; this one field does not, which the
 * copy is explicit about. It is here anyway because this is the dialog a user opens to
 * ask "how is this project set up".
 */
export function SpeleoUndoModeControl() {
  const { t } = useTranslation();
  const mode = useSpeleoStore((s) => s.link?.undoMode ?? 'full');
  const overridden = useSpeleoStore((s) => s.link?.undoModeOverridden ?? false);
  // A force-editor holds NO lock, so the backend refuses the write; offering it enabled
  // would be a control that can only fail.
  const iHoldLock = useSpeleoStore((s) => holdsWriteLock(s.link));
  const setUndoMode = useSpeleoStore((s) => s.setUndoMode);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (next: UndoMode | null) => {
    setBusy(true);
    setError(null);
    try {
      await setUndoMode(next);
    } catch (e) {
      setError(humanizeSpeleoError(e, t('speleodb.undoMode.failed')));
    } finally {
      setBusy(false);
    }
  };

  const option = (value: UndoMode, label: string, hint: string) => {
    const selected = mode === value;
    return (
      <label
        key={value}
        className={`flex gap-2 items-start rounded border px-2 py-1.5 cursor-pointer
          ${selected ? 'border-accent bg-accent-10' : 'border-border hover:bg-background-50'}
          ${iHoldLock && !busy ? '' : 'opacity-60 cursor-not-allowed'}`}
        data-testid={`speleodb-undo-mode-${value}`}
      >
        <input
          type="radio"
          name="speleodb-undo-mode"
          className="mt-1"
          checked={selected}
          disabled={!iHoldLock || busy}
          onChange={() => void apply(value)}
          data-testid={`speleodb-undo-mode-${value}-input`}
        />
        <span className="min-w-0">
          <span className="block text-sm text-text-primary">{label}</span>
          <span className="block text-xs text-text-secondary">{hint}</span>
        </span>
      </label>
    );
  };

  return (
    <div className="py-2 border-t border-border" data-testid="speleodb-undo-mode">
      <span className="block text-sm font-medium text-text-primary mb-1">
        {t('speleodb.undoMode.title')}
      </span>
      <p className="text-xs text-text-secondary pb-2">{t('speleodb.undoMode.description')}</p>

      <div className="space-y-1.5">
        {option('full', t('speleodb.undoMode.full'), t('speleodb.undoMode.fullHint'))}
        {option('disabled', t('speleodb.undoMode.disabled'), t('speleodb.undoMode.disabledHint'))}
      </div>

      <div className="flex items-center gap-2 pt-2">
        <span className="text-xs text-text-secondary" data-testid="speleodb-undo-mode-provenance">
          {overridden
            ? t('speleodb.undoMode.overridden')
            : t('speleodb.undoMode.followingDefault')}
        </span>
        {/* Clearing the override is its own action: "Full" set on the project and "Full"
            inherited from the application default are different states, and only the
            latter keeps tracking a later change to that default. */}
        {overridden && (
          <Button
            variant="secondary"
            disabled={!iHoldLock || busy}
            onClick={() => void apply(null)}
            data-testid="speleodb-undo-mode-use-default"
          >
            {t('speleodb.undoMode.useDefault')}
          </Button>
        )}
      </div>

      {!iHoldLock && (
        <p className="text-xs text-warning pt-1" data-testid="speleodb-undo-mode-lock-hint">
          {t('speleodb.undoMode.lockRequired')}
        </p>
      )}
      {error && (
        <p className="text-xs text-error pt-1" data-testid="speleodb-undo-mode-error">
          {error}
        </p>
      )}
    </div>
  );
}
