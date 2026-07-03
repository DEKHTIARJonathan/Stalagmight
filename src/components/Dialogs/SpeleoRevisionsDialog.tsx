import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { invokeIpc } from '../../utils/ipc';
import { humanizeSpeleoError } from '../../utils/speleoError';
import { formatDate } from '../../i18n/format';
import { DialogWrapper } from './DialogWrapper';
import type { SpeleoRevision } from '../../types/ipc.generated';

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
 * Read-only SpeleoDB revision history (#218). Opened for a remote project (from a
 * GlobalView remote row or the in-project SpeleoDB submenu) with `{ projectId,
 * projectName }` in the dialog data; fetches `speleodb_get_revisions` on mount and
 * renders the server-ordered (newest-first) commit chain: short SHA, author, date,
 * message, and a merge marker when a commit has more than one parent. Purely
 * informational - no action mutates anything.
 */
export default function SpeleoRevisionsDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const dialogData = useUIStore((s) => s.dialogData);
  const projectId = typeof dialogData.projectId === 'string' ? dialogData.projectId : null;
  const projectName = typeof dialogData.projectName === 'string' ? dialogData.projectName : '';

  const [revisions, setRevisions] = useState<SpeleoRevision[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return undefined;
    let cancelled = false;
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

  return (
    <DialogWrapper
      title={t('speleodb.revisions.title', { name: projectName })}
      onClose={closeDialog}
      size="lg"
      data-testid="speleodb-revisions-dialog"
    >
      {error ? (
        <div
          className="p-3 bg-error-10 border border-error-20 rounded text-error text-sm"
          data-testid="speleodb-revisions-error"
        >
          {error}
        </div>
      ) : revisions === null ? (
        <div
          className="flex flex-col items-center justify-center gap-2 py-10"
          data-testid="speleodb-revisions-loading"
        >
          <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <span className="text-xs text-text-secondary">{t('speleodb.revisions.loading')}</span>
        </div>
      ) : revisions.length === 0 ? (
        <p className="text-sm text-text-secondary py-6 text-center" data-testid="speleodb-revisions-empty">
          {t('speleodb.revisions.empty')}
        </p>
      ) : (
        <ul
          className="divide-y divide-border border border-border rounded max-h-96 overflow-auto"
          data-testid="speleodb-revisions-list"
        >
          {revisions.map((rev) => (
            <li key={rev.id} className="p-3" data-testid={`speleodb-revision-${rev.id}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <code className="px-1.5 py-0.5 rounded bg-panel border border-border text-xs text-text-secondary">
                  {rev.id.slice(0, 8)}
                </code>
                {rev.parent_ids.length > 1 && (
                  <span className="px-1.5 py-0.5 rounded text-xs bg-warning-20 text-warning">
                    {t('speleodb.revisions.merge')}
                  </span>
                )}
                <span className="text-xs text-text-secondary truncate">
                  {rev.author_email || t('speleodb.revisions.unknownAuthor')}
                </span>
                {rev.authored_date && (
                  <span className="text-xs text-text-tertiary">· {formatWhen(rev.authored_date)}</span>
                )}
              </div>
              {rev.message && (
                <p className="mt-1 text-sm text-text-primary whitespace-pre-wrap break-words">
                  {rev.message}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </DialogWrapper>
  );
}
