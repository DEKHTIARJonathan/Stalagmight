import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CylindersTable } from './CylindersTable';

type PlanTab = 'cylinders' | 'profile';

/**
 * The Plan-mode bottom panel (#38): tabbed tabular data that replaces the survey data
 * table while planning. "Cylinders" is the rig editor; "Profile" is the anticipated
 * depth/time/gas profile for handoff to a deco app (Subsurface) - a stub for now, since
 * the backend doesn't yet return the per-route path (predecessor back-trace is future
 * work - see the PR's PR3). Tab state is local + transient (never persisted).
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
      <div className="flex-1 overflow-auto">
        {tab === 'cylinders' ? <CylindersTable /> : <ProfileStub />}
      </div>
    </div>
  );
}

function ProfileStub() {
  const { t } = useTranslation();
  return (
    <div
      className="h-full flex flex-col items-center justify-center text-center gap-1 p-6 text-text-secondary"
      data-testid="plan-profile-stub"
    >
      <p className="text-sm font-medium">{t('planTables.profile.title')}</p>
      <p className="text-xs">{t('planTables.profile.subtitle')}</p>
      <p className="text-xs opacity-70">{t('planTables.profile.comingSoon')}</p>
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
