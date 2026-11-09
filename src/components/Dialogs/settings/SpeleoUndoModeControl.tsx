import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSpeleoStore } from '../../../store/speleoStore';
import { humanizeSpeleoError } from '../../../utils/speleoError';
import type { UndoMode } from '../../../types/ipc.generated';

export function SpeleoUndoModeControl() {
  const { t } = useTranslation();
  const mode = useSpeleoStore((s) => s.link?.undoMode ?? 'full');
  const canEdit = useSpeleoStore((s) => s.link?.editState === 'editing');
  const setUndoMode = useSpeleoStore((s) => s.setUndoMode);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (next: UndoMode) => {
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
          ${canEdit && !busy ? '' : 'opacity-60 cursor-not-allowed'}`}
        data-testid={`speleodb-undo-mode-${value}`}
      >
        <input
          type="radio"
          name="speleodb-undo-mode"
          className="mt-1"
          checked={selected}
          disabled={!canEdit || busy}
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

      {!canEdit && (
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
