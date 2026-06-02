import { useTranslation } from 'react-i18next';
import type { RecentDensity } from './useRecentDensity';

interface RecentDensityToggleProps {
  density: RecentDensity;
  onChange: (density: RecentDensity) => void;
}

function CardsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function TableIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
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
