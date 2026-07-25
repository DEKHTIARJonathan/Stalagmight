import { useCallback, useEffect, useRef, useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { trackDialogComplete } from '../../utils/telemetry';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

export default function ErrorDialog() {
  const { closeDialog, dialogData } = useUIStore();

  const handleClose = useCallback(() => {
    trackDialogComplete('error');
    closeDialog();
  }, [closeDialog]);

  // Normalize dialogData values to strings to guard against non-string callers
  const rawMessage = dialogData.message;
  const message = typeof rawMessage === 'string' ? rawMessage : rawMessage ? String(rawMessage) : undefined;
  const rawTitle = dialogData.title;
  const title = (typeof rawTitle === 'string' ? rawTitle : rawTitle ? String(rawTitle) : undefined) ?? 'Error';
  const rawStack = dialogData.stackTrace;
  const stackTrace = typeof rawStack === 'string' ? rawStack : rawStack ? String(rawStack) : undefined;
  // Callers surfacing an actionable, non-bug condition (e.g. an import's
  // deferred-save failure - see surfaceImportWarnings) set this to drop the
  // "report this as a bug" hint, which would otherwise contradict the message.
  const hideReportHint = Boolean(dialogData.hideReportHint);

  const [copyFeedback, setCopyFeedback] = useState<'idle' | 'copied' | 'failed'>('idle');
  const feedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (feedbackTimeoutRef.current) {
        clearTimeout(feedbackTimeoutRef.current);
      }
    };
  }, []);

  /** Copy error message and stack trace to clipboard */
  const handleCopyError = useCallback(async () => {
    const errorText = stackTrace
      ? `${message ?? 'An error occurred.'}\n\n${stackTrace}`
      : (message ?? 'An error occurred.');

    // Clear any pending timeout
    if (feedbackTimeoutRef.current) {
      clearTimeout(feedbackTimeoutRef.current);
    }

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API not available');
      }
      await navigator.clipboard.writeText(errorText);
      setCopyFeedback('copied');
    } catch {
      setCopyFeedback('failed');
    }
    feedbackTimeoutRef.current = setTimeout(() => setCopyFeedback('idle'), 2000);
  }, [message, stackTrace]);

  return (
    <DialogWrapper title={title} onClose={handleClose} size="md" data-testid="error-dialog">
      <div className="space-y-4">
        <p className="text-text-secondary whitespace-pre-wrap">{message ?? 'An error occurred.'}</p>

        {stackTrace && (
          <pre
            className="p-2 bg-surface-alt rounded text-xs text-text-tertiary overflow-auto max-h-48"
            data-testid="error-dialog-stack-trace"
          >
            {stackTrace}
          </pre>
        )}

        {!hideReportHint && (
          <p className="text-xs text-text-tertiary">
            {stackTrace
              ? 'If this error persists, please report it as a bug and include the error message and stack trace above.'
              : 'If this error persists, please report it as a bug and include this error message.'}
          </p>
        )}

        <div className="flex justify-between items-center pt-4 border-t border-border">
          <button
            type="button"
            onClick={handleCopyError}
            className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
            data-testid="error-dialog-copy-btn"
          >
            {copyFeedback === 'copied' ? 'Copied!' : copyFeedback === 'failed' ? 'Failed' : 'Copy to clipboard'}
          </button>
          <Button onClick={handleClose}>OK</Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
