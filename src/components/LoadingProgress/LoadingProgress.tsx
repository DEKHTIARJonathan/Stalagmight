import React from 'react';

export interface LoadingProgressProps {
  title: string;                    // "Loading ProjectName..."
  phase: string;                    // Current phase label
  phaseProgress?: number;           // 0-100 or undefined for indeterminate
  phaseCurrent?: number;            // e.g., 23
  phaseTotal?: number;              // e.g., 50
  overallProgress: number;          // 0-100
  onCancel?: () => void;            // Cancel handler
  error?: {
    message: string;
    details?: string;
  };
}

export function LoadingProgress({
  title,
  phase,
  phaseProgress,
  phaseCurrent,
  phaseTotal,
  overallProgress,
  onCancel,
  error,
}: LoadingProgressProps) {
  const [detailsExpanded, setDetailsExpanded] = React.useState(false);
  const isIndeterminate = phaseProgress === undefined;

  return (
    <div
      className="w-80 bg-panel rounded-lg shadow-lg p-6"
      role="dialog"
      aria-labelledby="loading-title"
      aria-describedby="loading-phase"
    >
      {/* Title */}
      <h2 id="loading-title" className="text-lg font-medium text-text-primary mb-4">
        {title}
      </h2>

      {/* Overall Progress */}
      <div className="mb-4">
        <div className="flex justify-between text-sm text-text-secondary mb-1">
          <span>Overall</span>
          <span>{Math.round(overallProgress)}%</span>
        </div>
        <div className="h-1.5 bg-border rounded-full overflow-hidden">
          <div
            className="h-full bg-accent transition-all duration-300"
            style={{ width: `${overallProgress}%` }}
            role="progressbar"
            aria-valuenow={Math.round(overallProgress)}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
      </div>

      {/* Current Phase */}
      <div
        id="loading-phase"
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
            <div className="h-full bg-accent/70 animate-pulse-shimmer" />
          ) : (
            <div
              className="h-full bg-accent/70 transition-all duration-150"
              style={{ width: `${phaseProgress}%` }}
              role="progressbar"
              aria-valuenow={Math.round(phaseProgress)}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          )}
        </div>
      </div>

      {/* Cancel Button */}
      {onCancel && !error && (
        <button
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
                onClick={() => setDetailsExpanded(!detailsExpanded)}
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
        </div>
      )}
    </div>
  );
}
