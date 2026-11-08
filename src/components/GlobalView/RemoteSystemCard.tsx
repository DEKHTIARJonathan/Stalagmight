import { type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { SpeleoProjectSummary } from '../../types/ipc.generated';
import { SpeleoProjectInfo } from './SpeleoProjectInfo';
import { Button } from '../common/Button';
import {
  recentAccent,
  recentAccentStyle,
  type SpeleoLockInfo,
} from './SpeleoLockBadge';

interface RemoteSystemCardProps {
  summary: SpeleoProjectSummary;
  /** Lock state for the badge, resolved from the scan for this project id (#218). */
  lock: SpeleoLockInfo;
  /** Pull + open this remote project (shared `useOpenRemoteProject` flow). */
  onOpen: (summary: SpeleoProjectSummary) => void;
  /** Disable actions while an open/adopt is in flight. */
  busy?: boolean;
}

/**
 * Card for a SpeleoDB project, whether or not it has been downloaded before. It carries no local file/stats, so it shows the SpeleoDB name
 * + lock badge and a single Open action that pulls it (like the browser dialog). The
 * whole card is clickable for discoverability; the Open button stops propagation so
 * it doesn't double-fire.
 */
export default function RemoteSystemCard({
  summary,
  lock,
  onOpen,
  busy = false,
}: RemoteSystemCardProps) {
  const { t } = useTranslation();
  const displayLock = { ...lock, hasLocalEdits: false };
  const testId = `system-card-remote-${summary.id}`;
  // Gate the whole-card click on `busy` too, not just the Open button - otherwise a
  // click on the card body (or Enter/Space) bypasses the disabled button and fires a
  // concurrent open.
  const open = () => {
    if (!busy) onOpen(summary);
  };

  return (
    <div
      className={`bg-panel border border-border rounded-lg p-4 transition-colors ${
        busy ? 'opacity-60 cursor-default' : 'cursor-pointer hover:border-accent'
      }`}
      style={recentAccentStyle(displayLock)}
      data-testid={testId}
      data-remote="true"
      data-recent-accent={recentAccent(displayLock)}
      role="button"
      aria-disabled={busy || undefined}
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          open();
        }
      }}
    >
      <h3 className="text-lg font-medium mb-1">{summary.name}</h3>
      <div className="mb-3" data-testid={`${testId}-path`}>
        <SpeleoProjectInfo lock={displayLock} summary={summary} testIdPrefix={`${testId}-speleo`} />
      </div>

      <div className="mt-3 pt-3 border-t border-border flex items-center justify-end gap-2">
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
