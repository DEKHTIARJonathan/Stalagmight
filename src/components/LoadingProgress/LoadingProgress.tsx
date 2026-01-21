import React from 'react';

export interface LoadingProgressProps {
  title: string;                    // "Loading ProjectName..."
  phase: string;                    // Current phase label
  phaseProgress?: number;           // 0-100 or undefined for indeterminate
  phaseCurrent?: number;            // e.g., 23
  phaseTotal?: number;              // e.g., 50
  overallProgress: number;          // 0-100
  onCancel?: () => void;            // Cancel handler (also used for dismiss on error)
  onRetry?: () => void;             // Retry handler (shown on error)
  error?: {
    message: string;
    details?: string | undefined;
  };
}

/** Clamp a number to [0, 100], treating NaN/Infinity as 0 */
function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function LoadingProgress({
  title,
  phase,
  phaseProgress,
  phaseCurrent,
  phaseTotal,
  overallProgress,
  onCancel,
  onRetry,
  error,
}: LoadingProgressProps) {
  const [detailsExpanded, setDetailsExpanded] = React.useState(false);
  const [copyFeedback, setCopyFeedback] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const isIndeterminate = phaseProgress === undefined;
  const titleId = React.useId();
  const phaseId = React.useId();
  const detailsId = React.useId();

  // Ref for cleanup of feedback timeout
  const feedbackTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return () => {
      if (feedbackTimeoutRef.current) {
        clearTimeout(feedbackTimeoutRef.current);
      }
    };
  }, []);

  /** Copy error message and details to clipboard with error handling */
  const handleCopyError = React.useCallback(async () => {
    if (!error) return;

    const errorText = error.details
      ? `${error.message}\n\n${error.details}`
      : error.message;

    // Clear any pending timeout
    if (feedbackTimeoutRef.current) {
      clearTimeout(feedbackTimeoutRef.current);
    }

    try {
      // Explicitly check clipboard API availability
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API not available');
      }
      await navigator.clipboard.writeText(errorText);
      setCopyFeedback('copied');
    } catch {
      setCopyFeedback('failed');
    }
    feedbackTimeoutRef.current = setTimeout(() => setCopyFeedback('idle'), 2000);
  }, [error]);

  // Clamp progress values
  const clampedOverall = clampProgress(overallProgress);
  const clampedPhase = phaseProgress !== undefined ? clampProgress(phaseProgress) : undefined;

  // Error state renders a different UI
  if (error) {
    return (
      <div
        className="w-80 bg-panel rounded-lg shadow-lg p-6"
        role="alert"
        aria-live="assertive"
      >
        {/* Error Title */}
        <h2 className="text-lg font-medium text-error mb-2">
          Failed to Load Project
        </h2>

        {/* Error Message */}
        <p className="text-text-secondary mb-3">
          {error.message}
        </p>

        {/* Show/Hide Details Toggle */}
        {error.details && (
          <div className="mb-4">
            <button
              type="button"
              onClick={() => setDetailsExpanded(v => !v)}
              className="text-sm text-text-tertiary hover:text-text-secondary"
              aria-expanded={detailsExpanded}
              aria-controls={detailsId}
            >
              {detailsExpanded ? '▼ Hide details' : '▶ Show details'}
            </button>
            {detailsExpanded && (
              <pre
                id={detailsId}
                className="mt-2 p-2 bg-surface-alt rounded text-xs text-text-tertiary overflow-auto max-h-32"
              >
                {error.details}
              </pre>
            )}
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex gap-2">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="px-3 py-1.5 bg-accent text-white rounded hover:bg-accent/90 transition-colors"
            >
              Retry
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            disabled={!onCancel}
            className="px-3 py-1.5 bg-surface-alt text-text-primary rounded hover:bg-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Dismiss
          </button>
          <button
            type="button"
            onClick={handleCopyError}
            className="px-3 py-1.5 text-text-secondary hover:text-text-primary transition-colors"
            title="Copy error to clipboard"
          >
            {copyFeedback === 'copied' ? 'Copied!' : copyFeedback === 'failed' ? 'Failed' : 'Copy'}
          </button>
        </div>
      </div>
    );
  }

  // Normal progress UI
  return (
    <div
      className="w-80 bg-panel rounded-lg shadow-lg p-6"
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={phaseId}
    >
      {/* Title */}
      <h2 id={titleId} className="text-lg font-medium text-text-primary mb-4">
        {title}
      </h2>

      {/* Overall Progress */}
      <div className="mb-4">
        <div className="flex justify-between text-sm text-text-secondary mb-1">
          <span>Overall</span>
          <span>{Math.round(clampedOverall)}%</span>
        </div>
        <div className="h-1.5 bg-border rounded-full overflow-hidden">
          <div
            className="h-full bg-accent transition-all duration-300"
            style={{ width: `${clampedOverall}%` }}
            role="progressbar"
            aria-label="Overall progress"
            aria-valuenow={Math.round(clampedOverall)}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
      </div>

      {/* Current Phase */}
      <div
        id={phaseId}
        className="mb-4"
        role="status"
        aria-live="polite"
      >
        <div className="flex justify-between text-sm text-text-secondary mb-1">
          <span>{phase}</span>
          {phaseCurrent !== undefined && phaseTotal !== undefined && (
            <span>{phaseCurrent}/{phaseTotal}</span>
          )}
        </div>
        <div className="h-1 bg-border rounded-full overflow-hidden">
          {isIndeterminate ? (
            <div
              className="h-full bg-accent/70 animate-pulse-shimmer"
              role="progressbar"
              aria-label="Phase progress"
              aria-valuetext="Loading"
            />
          ) : (
            <div
              className="h-full bg-accent/70 transition-all duration-150"
              style={{ width: `${clampedPhase}%` }}
              role="progressbar"
              aria-label="Phase progress"
              aria-valuenow={Math.round(clampedPhase!)}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          )}
        </div>
      </div>

      {/* Cancel Button */}
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-text-secondary hover:text-text-primary transition-colors"
        >
          Cancel
        </button>
      )}
    </div>
  );
}
