import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

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
 * Survey icon - shows a connected network of shots/stations. Drawn with filled
 * shapes (not thin strokes) so it keeps a consistent weight under the
 * WebKit/WKWebView page-zoom UI scale (see webkit-icon-stroke-zoom note).
 */
function SurveyIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      {/* Connecting shots (filled bars) */}
      <rect x="8" y="4.9" width="8" height="2.2" rx="1.1" />
      <rect x="4.257" y="10.9" width="9.487" height="2.2" rx="1.1" transform="rotate(71.57 9 12)" />
      <rect x="10.257" y="10.9" width="9.487" height="2.2" rx="1.1" transform="rotate(108.43 15 12)" />
      {/* Stations (nodes) */}
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
    </svg>
  );
}

/**
 * Markers icon - a solid location pin (with a knocked-out hole). Filled so it
 * keeps a consistent weight under the page-zoom UI scale.
 */
function MarkersIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M12 21c-4-4-8-7.5-8-12a8 8 0 1 1 16 0c0 4.5-4 8-8 12z M12 6.5 a2.5 2.5 0 1 0 0 5 a2.5 2.5 0 1 0 0 -5 z"
      />
    </svg>
  );
}

/**
 * Floating toggle button to switch between survey geometry and markers-only view.
 * Shows in the top-right corner of the map (below navigation controls).
 */
export function ViewModeToggle({ mode, onModeChange }: ViewModeToggleProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const { t } = useTranslation();

  const handleClick = useCallback(() => {
    onModeChange(mode === 'survey' ? 'markers' : 'survey');
  }, [mode, onModeChange]);

  const tooltipText = mode === 'survey'
    ? t('globalView.viewMode.switchToMarkers')
    : t('globalView.viewMode.switchToSurvey');

  return (
    <div className="relative">
      <button
        onClick={handleClick}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className="
          bg-panel border border-border rounded p-2
          hover:bg-background transition-colors duration-200
          focus:outline-none focus-visible:ring-2 focus-visible:ring-accent
          group leading-none
        "
        aria-label={tooltipText}
        data-testid="view-mode-toggle"
      >
        <span className="block transition-transform duration-200 group-hover:scale-110 group-active:scale-95">
          {mode === 'survey' ? <SurveyIcon /> : <MarkersIcon />}
        </span>
      </button>

      {/* Tooltip */}
      {showTooltip && (
        <div
          className="
            absolute right-full mr-2 top-1/2 -translate-y-1/2
            bg-panel-90 text-text-primary text-xs px-2 py-1 rounded border border-border
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
