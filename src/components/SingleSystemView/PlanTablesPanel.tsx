import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CylindersTable } from './CylindersTable';
import { ProfileChart } from './ProfileChart';

type PlanTab = 'cylinders' | 'profile';

/**
 * The Plan-mode bottom panel (#38): tabbed tabular data that replaces the survey data
 * table while planning. "Cylinders" is the rig editor; "Profile" is the anticipated
 * depth/distance/runtime profile of the planned route (#299), drawn from the round-trip
 * series the gas engine now publishes on `GasReachField.route_profile`. Tab state is
 * local + transient (never persisted).
 */
export function PlanTablesPanel() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<PlanTab>('cylinders');
  return (
    <div className="h-full bg-panel flex flex-col" data-testid="plan-tables-panel">
      <div className="flex border-b border-border shrink-0">
        <TabButton active={tab === 'cylinders'} onClick={() => setTab('cylinders')} testId="plan-tab-cylinders">
          {t('planTables.tabs.cylinders')}
        </TabButton>
        <TabButton active={tab === 'profile'} onClick={() => setTab('profile')} testId="plan-tab-profile">
          {t('planTables.tabs.profile')}
        </TabButton>
      </div>
      {/* The chart sizes itself to the panel, so its pane must not scroll - it clips instead. */}
      <div className={`flex-1 min-h-0 ${tab === 'cylinders' ? 'overflow-auto' : 'overflow-hidden'}`}>
        {tab === 'cylinders' ? <CylindersTable /> : <ProfileChart />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
        active
          ? 'border-accent text-text-primary'
          : 'border-transparent text-text-secondary hover:text-text-primary'
      }`}
      data-testid={testId}
    >
      {children}
    </button>
  );
}
