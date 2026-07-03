import { type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { SpeleoProjectSummary } from '../../types/ipc.generated';
import { Button } from '../common/Button';
import { SpeleoRecentInfo, type SpeleoLockInfo } from './SpeleoLockBadge';

interface RemoteSystemCardProps {
  summary: SpeleoProjectSummary;
  /** Lock state for the badge, resolved from the scan for this project id (#218). */
  lock: SpeleoLockInfo;
  /** Pull + open this remote project (shared `useOpenRemoteProject` flow). */
  onOpen: (summary: SpeleoProjectSummary) => void;
  /** Open the read-only revision-history view for this project (#218). */
  onViewHistory: (projectId: string, projectName: string) => void;
  /** Disable actions while an open/adopt is in flight. */
  busy?: boolean;
}

/**
 * Card for a purely-remote SpeleoDB project (#218): accessible on the server but
 * not pulled locally. It carries no local file/stats, so it shows the SpeleoDB name
 * + lock badge and a single Open action that pulls it (like the browser dialog). The
 * whole card is clickable for discoverability; the Open button stops propagation so
 * it doesn't double-fire.
 */
export default function RemoteSystemCard({
  summary,
  lock,
  onOpen,
  onViewHistory,
  busy = false,
}: RemoteSystemCardProps) {
  const { t } = useTranslation();
  const open = () => onOpen(summary);

  return (
    <div
      className="bg-panel border border-border rounded-lg p-4 cursor-pointer transition-colors hover:border-accent"
      data-testid={`system-card-remote-${summary.id}`}
      data-remote="true"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
    >
      <h3 className="text-lg font-medium mb-1">{summary.name}</h3>
      <div className="mb-3" data-testid="system-card-path">
        <SpeleoRecentInfo info={lock} name={summary.name} />
      </div>

      <div className="mt-3 pt-3 border-t border-border flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={(e: MouseEvent) => {
            e.stopPropagation();
            onViewHistory(summary.id, summary.name);
          }}
          className="text-xs text-text-secondary hover:underline"
          data-testid={`system-card-remote-history-${summary.id}`}
        >
          {t('speleodb.revisions.action')}
        </button>
        <Button
          variant="primary"
          onClick={(e: MouseEvent) => {
            e.stopPropagation();
            open();
          }}
          disabled={busy}
          data-testid={`system-card-remote-open-${summary.id}`}
        >
          {t('speleodb.browser.open')}
        </Button>
      </div>
    </div>
  );
}
