import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { useOpenRemoteProject } from '../../hooks/useOpenRemoteProject';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type { SpeleoProjectSummary, UnpushedLocalEdits } from '../../types/ipc.generated';

/**
 * [#270] Refused-open prompt: re-opening this SpeleoDB project from the server
 * would have overwritten a cached `.stalx` that still holds edits SpeleoDB has
 * never seen, so the backend refused (`SpeleoDbAction::UnpushedLocalEdits`) and
 * `useOpenRemoteProject` raises this instead of a dead-end error.
 *
 * Binary by design - merging the two copies is explicitly out of scope for now:
 *
 * - Keep the local copy (PRIMARY, and what a stray Enter does): opens the local
 *   path from the refusal with NO SpeleoDB command at all. Nothing is downloaded,
 *   nothing is overwritten.
 * - Take the server copy (destructive, two-step): re-runs the open through
 *   `speleodb_open_project_discarding_local`, permanently dropping the local
 *   edits. The first press only arms it, the same arm-then-confirm shape
 *   {@link SpeleoQuitDialog}'s discard action uses.
 *
 * The stakes are spelled out concretely - the project name and when the local copy
 * was last edited - because a vague prompt is what makes people click the wrong
 * button on an irreversible choice.
 */
export default function SpeleoUnpushedLocalDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const dialogData = useUIStore((s) => s.dialogData);
  // Close the prompt right before loadProject so its progress is visible (the same
  // hand-off the browser dialog makes).
  const { keepLocalCopy, takeRemoteDiscardingLocal } = useOpenRemoteProject({
    onBeforeLoad: closeDialog,
  });

  const [busy, setBusy] = useState(false);
  const [discardArmed, setDiscardArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const summary = dialogData.summary as SpeleoProjectSummary | undefined;
  const unpushedLocal = dialogData.unpushedLocal as UnpushedLocalEdits | undefined;
  if (!summary || !unpushedLocal) return null;

  const lastEditAt = unpushedLocal.last_edit_at;
  const parsed = lastEditAt ? new Date(lastEditAt) : null;
  const lastEditedLine =
    parsed && !Number.isNaN(parsed.getTime())
      ? t('speleodb.unpushedLocal.lastEdited', { when: parsed.toLocaleString() })
      : t('speleodb.unpushedLocal.lastEditedUnknown');

  // Safe branch: open the local copy, no SpeleoDB call. A failed load surfaces its
  // own error through loadProject (the prompt has already handed off by then).
  const handleKeepLocal = async () => {
    setBusy(true);
    setError(null);
    const outcome = await keepLocalCopy(summary, unpushedLocal.local_path);
    if (outcome.status === 'error') {
      setError(outcome.message);
      setBusy(false);
    }
  };

  // Destructive branch. A failed re-pull keeps this prompt open with the reason on
  // screen: closing it would leave the user with nothing opened and no explanation.
  // The discard stays armed so the button is a retry, not a re-arm.
  const handleTakeRemote = async () => {
    setBusy(true);
    setError(null);
    const outcome = await takeRemoteDiscardingLocal(summary);
    if (outcome.status === 'error') {
      setError(outcome.message);
      setBusy(false);
    }
  };

  return (
    <DialogWrapper
      title={t('speleodb.unpushedLocal.title')}
      onClose={closeDialog}
      size="md"
      data-testid="speleodb-unpushed-local-dialog"
    >
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          {t('speleodb.unpushedLocal.message', { name: summary.name })}
        </p>
        <p className="text-sm text-text-primary" data-testid="speleodb-unpushed-local-last-edited">
          {lastEditedLine}
        </p>
        <p className="text-xs text-text-secondary">{t('speleodb.unpushedLocal.keepHint')}</p>

        {discardArmed && (
          <div
            className="rounded border border-error bg-error-20 text-error text-sm px-3 py-2"
            role="alert"
            data-testid="speleodb-unpushed-local-discard-warning"
          >
            {t('speleodb.unpushedLocal.discardWarning', { name: summary.name })}
          </div>
        )}

        {error && (
          <div
            className="p-3 bg-error-10 border border-error-20 rounded text-error text-sm"
            role="alert"
            data-testid="speleodb-unpushed-local-error"
          >
            {error}
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-border">
          <Button onClick={closeDialog} disabled={busy} data-testid="speleodb-unpushed-local-cancel">
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (!discardArmed) {
                setDiscardArmed(true);
                return;
              }
              void handleTakeRemote();
            }}
            disabled={busy}
            data-testid="speleodb-unpushed-local-take-remote"
          >
            {discardArmed
              ? t('speleodb.unpushedLocal.takeRemoteConfirm')
              : t('speleodb.unpushedLocal.takeRemote')}
          </Button>
          {/* Primary + [data-primary-action]: DialogWrapper's initial-focus heuristic
              lands here, so a stray Enter keeps the local work - it can never
              discard it. */}
          <Button
            variant="primary"
            onClick={() => void handleKeepLocal()}
            disabled={busy}
            data-primary-action=""
            data-testid="speleodb-unpushed-local-keep"
          >
            {t('speleodb.unpushedLocal.keepLocal')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
