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
  const isIndeterminate = phaseProgress === undefined;
  const titleId = React.useId();
  const phaseId = React.useId();

  // Clamp progress values
  const clampedOverall = clampProgress(overallProgress);
  const clampedPhase = phaseProgress !== undefined ? clampProgress(phaseProgress) : undefined;

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
      {onCancel && !error && (
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-text-secondary hover:text-text-primary transition-colors"
        >
          Cancel
        </button>
      )}

      {/* Error State */}
      {error && (
        <div className="mt-4 p-3 bg-error/10 border border-error/30 rounded">
          <p className="text-error text-sm font-medium">{error.message}</p>
          {error.details && (
            <>
              <button
                type="button"
                onClick={() => setDetailsExpanded(v => !v)}
                className="text-xs text-text-secondary hover:text-text-primary mt-1"
              >
                {detailsExpanded ? 'Hide details' : 'Show details'}
              </button>
              {detailsExpanded && (
                <pre className="text-xs text-text-secondary mt-2 whitespace-pre-wrap">
                  {error.details}
                </pre>
              )}
            </>
          )}
          {/* Error Action Buttons */}
          <div className="mt-3 flex gap-2">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="px-3 py-1 text-sm bg-accent text-white rounded hover:bg-accent/90 transition-colors"
              >
                Retry
              </button>
            )}
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="px-3 py-1 text-sm text-text-secondary hover:text-text-primary transition-colors"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
