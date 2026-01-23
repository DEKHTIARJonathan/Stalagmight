import { useState, useCallback } from 'react';

/** View mode for GlobalView map */
export type ViewMode = 'survey' | 'markers';

/** Local storage key for persisted view mode */
const STORAGE_KEY = 'globalViewMode';

interface ViewModeToggleProps {
  /** Current view mode */
  mode: ViewMode;
  /** Callback when mode changes */
  onModeChange: (mode: ViewMode) => void;
}

/**
 * Custom hook to persist view mode in local storage.
 * Returns the current mode and a setter function.
 */
export function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setModeState] = useState<ViewMode>(() => {
    // Initialize from local storage
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'survey' || stored === 'markers') {
        return stored;
      }
    } catch {
      // localStorage may be unavailable
    }
    return 'survey'; // Default to survey view
  });

  const setMode = useCallback((newMode: ViewMode) => {
    setModeState(newMode);
    try {
      localStorage.setItem(STORAGE_KEY, newMode);
    } catch {
      // localStorage may be unavailable
    }
  }, []);

  return [mode, setMode];
}

/**
 * Survey icon - shows a connected network of shots/stations.
 */
function SurveyIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Survey network: connected points */}
      <circle cx="6" cy="6" r="2" fill="currentColor" />
      <circle cx="18" cy="6" r="2" fill="currentColor" />
      <circle cx="12" cy="18" r="2" fill="currentColor" />
      <line x1="7.5" y1="7.5" x2="10.5" y2="16.5" />
      <line x1="16.5" y1="7.5" x2="13.5" y2="16.5" />
      <line x1="8" y1="6" x2="16" y2="6" />
    </svg>
  );
}

/**
 * Markers icon - shows simple location pins.
 */
function MarkersIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Location marker pin */}
      <path d="M12 21c-4-4-8-7.5-8-12a8 8 0 1 1 16 0c0 4.5-4 8-8 12z" />
      <circle cx="12" cy="9" r="2.5" fill="currentColor" />
    </svg>
  );
}

/**
 * Floating toggle button to switch between survey geometry and markers-only view.
 * Shows in the top-right corner of the map (below navigation controls).
 */
export function ViewModeToggle({ mode, onModeChange }: ViewModeToggleProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  const handleClick = useCallback(() => {
    onModeChange(mode === 'survey' ? 'markers' : 'survey');
  }, [mode, onModeChange]);

  const tooltipText = mode === 'survey'
    ? 'Switch to markers only'
    : 'Show survey geometry';

  return (
    <div className="relative">
      <button
        onClick={handleClick}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className="
          bg-panel border border-border rounded p-2
          hover:bg-background transition-colors duration-200
          focus:outline-none focus:ring-2 focus:ring-accent
          group
        "
        aria-label={tooltipText}
        data-testid="view-mode-toggle"
      >
        <span className="inline-block transition-transform duration-200 group-hover:scale-110 group-active:scale-95">
          {mode === 'survey' ? <SurveyIcon /> : <MarkersIcon />}
        </span>
      </button>

      {/* Tooltip */}
      {showTooltip && (
        <div
          className="
            absolute right-full mr-2 top-1/2 -translate-y-1/2
            bg-gray-900 text-white text-xs px-2 py-1 rounded
            whitespace-nowrap pointer-events-none z-10
          "
          role="tooltip"
        >
          {tooltipText}
        </div>
      )}
    </div>
  );
}

export default ViewModeToggle;
