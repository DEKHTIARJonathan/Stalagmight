import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useSpeleoActions } from '../../hooks/useSpeleoActions';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

/**
 * Commit-message confirm for the action shell (#204), in two modes read off
 * `dialogData.mode`:
 * - **release** (default): `speleodb_done` — render + VACUUM snapshot + push +
 *   release the lock, returning to read-only.
 * - **push** (T2d, fix 8): `speleodb_push` — the same push WITHOUT releasing the
 *   lock, so editing continues.
 *
 * Both collect an optional message then route through `useSpeleoActions`. Closes on
 * any resolved outcome — released / pushed / divergence / push-unconfirmed are
 * surfaced by the store (toast / #198 stub / #200 banner); only a thrown (network)
 * error keeps the dialog open so the typed message and a retry survive.
 */
export default function SpeleoDoneDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const mode = useUIStore((s) => s.dialogData.mode) === 'push' ? 'push' : 'release';
  const { busy, push, done } = useSpeleoActions();
  const [message, setMessage] = useState('');

  const handleConfirm = async () => {
    const text = message.trim() || null;
    if (mode === 'push') {
      // push() has no return we branch on; the store surfaces the outcome. Close
      // optimistically — a network throw shows a toast and the dialog is already
      // gone, but the retry lives on the button.
      await push(text);
      closeDialog();
    } else {
      const resolved = await done(text);
      if (resolved) closeDialog();
    }
  };

  return (
    <DialogWrapper
      title={mode === 'push' ? t('speleodb.done.pushTitle') : t('speleodb.done.title')}
      onClose={closeDialog}
      size="md"
      data-testid="speleodb-done-dialog"
      data-mode={mode}
    >
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          {mode === 'push' ? t('speleodb.done.pushDescription') : t('speleodb.done.description')}
        </p>
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
            onClick={() => void handleConfirm()}
            disabled={busy}
            data-testid="speleodb-done-confirm"
          >
            {busy
              ? t('speleodb.done.pushing')
              : mode === 'push'
                ? t('speleodb.done.pushConfirm')
                : t('speleodb.done.confirm')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
