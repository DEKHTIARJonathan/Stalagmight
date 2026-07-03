import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsSection } from './SettingsSection';
import { Button } from '../../common/Button';
import { useUIStore } from '../../../store/uiStore';
import { useSpeleoStore } from '../../../store/speleoStore';
import { useProjectStore } from '../../../store/projectStore';
import { invokeIpc } from '../../../utils/ipc';
import { humanizeSpeleoError } from '../../../utils/speleoError';
import { formatDate } from '../../../i18n/format';
import type { SpeleoRevision } from '../../../types/ipc.generated';

/** RFC-3339 -> localized date/time; falls back to the raw string if unparseable. */
function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return formatDate(date, undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * [#218] Read-only revision history for the open remote project, shown in the
 * Project Settings SpeleoDB tab directly below the Lock section. Fetches
 * `speleodb_get_revisions` on mount and lists the server-ordered (newest-first)
 * commit chain: short SHA, author, date, message, a merge marker for >1 parent.
 *
 * Each PAST revision offers Restore - a git-forward restore that pulls that
 * revision's tree into the working copy as unsaved edits (the confirm dialog
 * carries the disclaimer + unsaved-changes safeguard). Restore is gated on holding
 * the lock (you can only change a project you are editing); the newest commit is
 * the current server state and is marked, not restorable.
 */
export function SpeleoRevisionHistory() {
  const { t } = useTranslation();
  const openDialog = useUIStore((s) => s.openDialog);
  const projectId = useSpeleoStore((s) => s.remoteProjectId);
  const iHoldLock = useSpeleoStore((s) => s.link?.editState === 'editing');
  const projectName = useProjectStore((s) => s.project?.name ?? '');

  const [revisions, setRevisions] = useState<SpeleoRevision[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return undefined;
    let cancelled = false;
    setRevisions(null);
    setError(null);
    void (async () => {
      try {
        const list = await invokeIpc<SpeleoRevision[]>('speleodb_get_revisions', { projectId });
        if (!cancelled) setRevisions(list);
      } catch (e) {
        if (!cancelled) setError(humanizeSpeleoError(e, t('speleodb.revisions.failed')));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, t]);

  // A local project (no open remote) has no history to show.
  if (!projectId) return null;

  return (
    <SettingsSection title={t('speleodb.revisions.title')} data-testid="speleodb-revisions">
      {error ? (
        <p className="text-error text-sm" data-testid="speleodb-revisions-error">
          {error}
        </p>
      ) : revisions === null ? (
        <p className="text-text-secondary text-sm" data-testid="speleodb-revisions-loading">
          {t('speleodb.revisions.loading')}
        </p>
      ) : revisions.length === 0 ? (
        <p className="text-text-secondary text-sm" data-testid="speleodb-revisions-empty">
          {t('speleodb.revisions.empty')}
        </p>
      ) : (
        <ul
          className="divide-y divide-border border border-border rounded max-h-80 overflow-auto"
          data-testid="speleodb-revisions-list"
        >
          {revisions.map((rev, idx) => {
            // Server order is newest-first, so index 0 is the current server HEAD:
            // restoring to it would be a no-op, so it is marked, not restorable.
            const isCurrent = idx === 0;
            return (
              <li
                key={rev.id}
                className="p-2.5 flex items-start gap-2"
                data-testid={`speleodb-revision-${rev.id}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="px-1.5 py-0.5 rounded bg-panel border border-border text-xs text-text-secondary">
                      {rev.id.slice(0, 8)}
                    </code>
                    {isCurrent && (
                      <span
                        className="px-1.5 py-0.5 rounded text-xs bg-accent-20 text-accent"
                        data-testid={`speleodb-revision-current-${rev.id}`}
                      >
                        {t('speleodb.revisions.current')}
                      </span>
                    )}
                    {rev.parent_ids.length > 1 && (
                      <span className="px-1.5 py-0.5 rounded text-xs bg-warning-20 text-warning">
                        {t('speleodb.revisions.merge')}
                      </span>
                    )}
                    <span className="text-xs text-text-secondary truncate">
                      {rev.author_email || t('speleodb.revisions.unknownAuthor')}
                    </span>
                    {rev.authored_date && (
                      <span className="text-xs text-text-tertiary">
                        · {formatWhen(rev.authored_date)}
                      </span>
                    )}
                  </div>
                  {rev.message && (
                    <p className="mt-0.5 text-sm text-text-primary whitespace-pre-wrap break-words">
                      {rev.message}
                    </p>
                  )}
                </div>
                {!isCurrent && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!iHoldLock}
                    title={iHoldLock ? undefined : t('speleodb.revisions.restoreNeedsLock')}
                    onClick={() =>
                      openDialog('speleodb-restore', {
                        projectId,
                        projectName,
                        hexsha: rev.id,
                        shortSha: rev.id.slice(0, 8),
                        message: rev.message ?? '',
                      })
                    }
                    data-testid={`speleodb-revision-restore-${rev.id}`}
                  >
                    {t('speleodb.revisions.restore')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SettingsSection>
  );
}
