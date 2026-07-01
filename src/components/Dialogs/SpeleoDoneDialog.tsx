import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoActions } from '../../hooks/useSpeleoActions';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

/**
 * "Done" confirm for the action shell (#204): collects an optional commit message
 * then runs `speleodb_done` (render + VACUUM snapshot + push + release) through
 * `useSpeleoActions`. Closes on any resolved outcome — released / divergence /
 * push-unconfirmed are surfaced by the store (toast / #198 stub / #200 banner);
 * only a thrown (network) error keeps the dialog open so the typed message and a
 * retry survive.
 */
export default function SpeleoDoneDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const { busy, done } = useSpeleoActions();
  const [message, setMessage] = useState('');

  const handleDone = async () => {
    const resolved = await done(message.trim() || null);
    if (resolved) closeDialog();
  };

  return (
    <DialogWrapper
      title={t('speleodb.done.title')}
      onClose={closeDialog}
      size="md"
      data-testid="speleodb-done-dialog"
    >
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">{t('speleodb.done.description')}</p>
        <div>
          <label className="block text-sm text-text-secondary mb-1">
            {t('speleodb.done.messageLabel')}
          </label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            className="w-full px-2 py-1 bg-background border border-border rounded text-sm"
            placeholder={t('speleodb.done.messagePlaceholder')}
            data-testid="speleodb-done-message"
          />
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button onClick={closeDialog} disabled={busy} data-testid="speleodb-done-cancel">
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleDone()}
            disabled={busy}
            data-testid="speleodb-done-confirm"
          >
            {busy ? t('speleodb.done.pushing') : t('speleodb.done.confirm')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
