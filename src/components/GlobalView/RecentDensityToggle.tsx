import { useTranslation } from 'react-i18next';
import type { RecentDensity } from './useRecentDensity';

interface RecentDensityToggleProps {
  density: RecentDensity;
  onChange: (density: RecentDensity) => void;
}

// Filled shapes (not thin strokes) so the icons keep a consistent weight under
// the WebKit/WKWebView page-zoom UI scale (see webkit-icon-stroke-zoom note).
function CardsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </svg>
  );
}

function TableIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="3" y="4.9" width="18" height="2.2" rx="1.1" />
      <rect x="3" y="10.9" width="18" height="2.2" rx="1.1" />
      <rect x="3" y="16.9" width="18" height="2.2" rx="1.1" />
    </svg>
  );
}

/**
 * Segmented toggle between the card grid and the compact table view of the
 * recent-projects list. State is owned by the caller (persisted via
 * useRecentDensity).
 */
export function RecentDensityToggle({ density, onChange }: RecentDensityToggleProps) {
  const { t } = useTranslation();

  const option = (value: RecentDensity, label: string, icon: JSX.Element, testId: string) => {
    const active = density === value;
    return (
      <button
        type="button"
        onClick={() => onChange(value)}
        className={`inline-flex items-center justify-center w-8 h-8 transition-colors ${
          active ? 'bg-accent-20 text-accent' : 'text-text-secondary hover:text-text'
        }`}
        aria-label={label}
        aria-pressed={active}
        title={label}
        data-testid={testId}
      >
        {icon}
      </button>
    );
  };

  return (
    <div
      className="inline-flex items-center rounded border border-border overflow-hidden"
      role="group"
      aria-label={t('globalView.recent.density.label')}
      data-testid="recent-density-toggle"
    >
      {option('cards', t('globalView.recent.density.cards'), <CardsIcon />, 'recent-density-cards')}
      {option('table', t('globalView.recent.density.table'), <TableIcon />, 'recent-density-table')}
    </div>
  );
}

export default RecentDensityToggle;
